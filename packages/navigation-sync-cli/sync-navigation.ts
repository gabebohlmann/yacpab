#!/usr/bin/env node

const chokidar = require('chokidar')
const fs = require('fs-extra')
const path = require('path')
const inquirer = require('inquirer')
const simpleGit = require('simple-git')
const ts = require('typescript')

// Determine MONOREPO_ROOT
const MONOREPO_ROOT = process.cwd()
console.log(`CLI operating with MONOREPO_ROOT: ${MONOREPO_ROOT}`)

const git = simpleGit({ baseDir: MONOREPO_ROOT })

const NAVIGATION_CONFIG_PATH = path.join(
  MONOREPO_ROOT,
  'packages/app/features/navigation/layout.tsx'
)
const FEATURES_PATH = path.join(MONOREPO_ROOT, 'packages/app/features')
const EXPO_APP_PATH = path.join(MONOREPO_ROOT, 'apps/expo/app')
const NEXT_APP_PATH = path.join(MONOREPO_ROOT, 'apps/next/app')

let lastAcknowledgedConfigState = null
let actionInProgress = false
let ignoreNextConfigChange = false
let reevaluateAfterCompletion = false

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

async function parseNavigationConfig(filePath) {
  try {
    const fileContent = await fs.readFile(filePath, 'utf-8')
    const sourceFile = ts.createSourceFile(
      path.basename(filePath),
      fileContent,
      ts.ScriptTarget.ESNext,
      true
    )

    const parsedScreens = []
    function visit(node) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.name.getText(sourceFile) === 'appNavigationStructure') {
            if (decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
              const rootStack = decl.initializer.elements[0]
              if (rootStack && ts.isObjectLiteralExpression(rootStack)) {
                const screensProp = rootStack.properties.find(
                  (p) => p.name?.getText(sourceFile) === 'screens'
                )
                if (
                  screensProp &&
                  ts.isPropertyAssignment(screensProp) &&
                  ts.isArrayLiteralExpression(screensProp.initializer)
                ) {
                  const tabsNavigatorConfig = screensProp.initializer.elements.find((el) => {
                    if (ts.isObjectLiteralExpression(el)) {
                      const typeProp = el.properties.find(
                        (p) => p.name?.getText(sourceFile) === 'type'
                      )
                      const nameProp = el.properties.find(
                        (p) => p.name?.getText(sourceFile) === 'name'
                      )
                      return (
                        typeProp &&
                        ts.isPropertyAssignment(typeProp) &&
                        typeProp.initializer.getText(sourceFile).includes('tabs') &&
                        nameProp &&
                        ts.isPropertyAssignment(nameProp) &&
                        nameProp.initializer.getText(sourceFile).includes('(tabs)')
                      )
                    }
                    return false
                  })

                  if (tabsNavigatorConfig && ts.isObjectLiteralExpression(tabsNavigatorConfig)) {
                    const tabScreensProp = tabsNavigatorConfig.properties.find(
                      (p) => p.name?.getText(sourceFile) === 'screens'
                    )
                    if (
                      tabScreensProp &&
                      ts.isPropertyAssignment(tabScreensProp) &&
                      ts.isArrayLiteralExpression(tabScreensProp.initializer)
                    ) {
                      tabScreensProp.initializer.elements.forEach((tabScreenNode) => {
                        if (ts.isObjectLiteralExpression(tabScreenNode)) {
                          const screen = {}
                          tabScreenNode.properties.forEach((prop) => {
                            if (ts.isPropertyAssignment(prop) && prop.name) {
                              const propName = prop.name.getText(sourceFile)
                              const propValueNode = prop.initializer
                              let propValue = propValueNode.getText(sourceFile).replace(/'|"/g, '')

                              if (propName === 'name') screen.name = propValue
                              if (propName === 'component') screen.componentName = propValue
                              if (
                                propName === 'options' &&
                                ts.isObjectLiteralExpression(propValueNode)
                              ) {
                                propValueNode.properties.forEach((optProp) => {
                                  if (ts.isPropertyAssignment(optProp) && optProp.name) {
                                    const optName = optProp.name.getText(sourceFile)
                                    const optValue = optProp.initializer
                                      .getText(sourceFile)
                                      .replace(/'|"/g, '')
                                    if (optName === 'title') screen.title = optValue
                                    if (optName === 'tabBarIconName') screen.icon = optValue // Keep icon for context if needed
                                  }
                                })
                              }
                            }
                          })
                          if (screen.name && screen.componentName) parsedScreens.push(screen)
                        }
                      })
                    }
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return { screens: parsedScreens }
  } catch (error) {
    console.error('Error parsing navigation config:', error.message)
    if (error instanceof SyntaxError || error.message.includes('SyntaxError')) {
      console.warn(
        'Syntax error in navigation config, likely due to autosave. Skipping this change.'
      )
      return null
    }
    return null
  }
}

function identifyChanges(currentConfig, previousConfig) {
  const newScreens = []
  const deletedScreens = []
  const updatedScreens = []

  const currentScreenMap = new Map(currentConfig?.screens?.map((s) => [s.name, s]) || [])
  const previousScreenMap = new Map(previousConfig?.screens?.map((s) => [s.name, s]) || [])

  // Identify new and updated screens
  for (const [name, currentScreen] of currentScreenMap) {
    if (currentScreen.name && currentScreen.componentName) {
      // Basic validation
      const previousScreen = previousScreenMap.get(name)
      if (previousScreen) {
        // Screen exists in both, check for updates
        if (
          currentScreen.componentName !== previousScreen.componentName ||
          currentScreen.title !== previousScreen.title
        ) {
          updatedScreens.push({ oldScreen: previousScreen, newScreen: currentScreen })
        }
      } else {
        // Screen is new
        newScreens.push(currentScreen)
      }
    }
  }

  // Identify deleted screens
  for (const [name, previousScreen] of previousScreenMap) {
    if (previousScreen.name && previousScreen.componentName && !currentScreenMap.has(name)) {
      deletedScreens.push(previousScreen)
    }
  }
  return { newScreens, deletedScreens, updatedScreens }
}

async function checkUncommittedChanges() {
  const status = await git.status()
  const otherChanges = status.files.filter((file) => {
    const absoluteFilePath = path.isAbsolute(file.path)
      ? file.path
      : path.join(MONOREPO_ROOT, file.path)
    return absoluteFilePath !== NAVIGATION_CONFIG_PATH && file.working_dir !== '?'
  })
  return otherChanges
}

async function commitChanges(message, filesToAdd = []) {
  try {
    const absoluteFilesToAdd = filesToAdd.map((f) =>
      path.isAbsolute(f) ? f : path.join(MONOREPO_ROOT, f)
    )
    if (absoluteFilesToAdd.length > 0) {
      await git.add(absoluteFilesToAdd)
    } else {
      console.warn('Commit called with no specific files to add.')
    }
    await git.commit(message)
    console.log('Changes committed successfully.')
  } catch (error) {
    console.error('Error committing changes:', error)
  }
}

async function generateFeatureScreen(screenName, componentName, title, isUpdate = false) {
  const featurePath = path.join(FEATURES_PATH, screenName)
  const screenFilePath = path.join(featurePath, 'screen.tsx')

  if (await fs.pathExists(screenFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Feature screen file already exists: ${screenFilePath}. ${isUpdate ? 'Update (overwrite)?' : 'Overwrite?'}`,
        default: isUpdate, // Default to yes for updates, no for new if exists
      },
    ])
    if (!overwrite) {
      console.log(`Skipped ${isUpdate ? 'updating' : 'overwriting'}: ${screenFilePath}`)
      return null
    }
  }

  await fs.ensureDir(featurePath)
  const content = `// packages/app/features/${screenName}/screen.tsx
'use client';

import { View, Text, StyleSheet } from 'react-native';
import { useColorScheme } from "react-native"

export function ${componentName}() {
  const colorScheme = useColorScheme()

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: colorScheme === 'dark' ? '#121212' : '#FFFFFF' }}>
      <Text style={{ fontSize: 24, marginBottom: 10, color: colorScheme === 'dark' ? 'white' : 'black' }}>
        ${title || screenName} 
      </Text>
      <Text style={{ fontSize: 12, color: colorScheme === 'dark' ? 'white' : 'black' }}>
        This screen was ${isUpdate ? 'updated' : 'auto-generated'} by the CLI.
      </Text>
    </View>
  )
}

`
  await fs.writeFile(screenFilePath, content)
  console.log(`${isUpdate ? 'Updated' : 'Generated'}: ${screenFilePath}`)
  return screenFilePath
}

async function generateExpoTabFile(screenName, componentName, isUpdate = false) {
  const expoTabDir = path.join(EXPO_APP_PATH, '(tabs)')
  const expoFilePath = path.join(expoTabDir, `${screenName}.tsx`)

  if (await fs.pathExists(expoFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Expo tab file already exists: ${expoFilePath}. ${isUpdate ? 'Update (overwrite)?' : 'Overwrite?'}`,
        default: isUpdate,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped ${isUpdate ? 'updating' : 'overwriting'}: ${expoFilePath}`)
      return null
    }
  }

  await fs.ensureDir(expoTabDir)
  const content = `// apps/expo/app/(tabs)/${screenName}.tsx
import { ${componentName} } from 'app/features/${screenName}/screen';

export default function ${capitalizeFirstLetter(screenName)}TabPage() {
  return <${componentName} />;
}
`
  await fs.writeFile(expoFilePath, content)
  console.log(`${isUpdate ? 'Updated' : 'Generated'}: ${expoFilePath}`)
  return expoFilePath
}

async function generateNextPageFile(screenName, componentName, isUpdate = false) {
  const nextPageDir = path.join(NEXT_APP_PATH, '(tabs)', screenName)
  const nextFilePath = path.join(nextPageDir, 'page.tsx')

  if (await fs.pathExists(nextFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Next.js page file already exists: ${nextFilePath}. ${isUpdate ? 'Update (overwrite)?' : 'Overwrite?'}`,
        default: isUpdate,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped ${isUpdate ? 'updating' : 'overwriting'}: ${nextFilePath}`)
      return null
    }
  } else if ((await fs.pathExists(nextPageDir)) && !isUpdate) {
    console.log(`Directory ${nextPageDir} exists, but page.tsx will be created.`)
  } else if (!isUpdate) {
    // For new files, ensure dir
    await fs.ensureDir(nextPageDir)
  }

  const content = `// apps/next/app/(tabs)/${screenName}/page.tsx
'use client';

import { ${componentName} } from 'app/features/${screenName}/screen';

export default function ${capitalizeFirstLetter(screenName)}Page() {
  return <${componentName} />;
}
`
  await fs.writeFile(nextFilePath, content)
  console.log(`${isUpdate ? 'Updated' : 'Generated'}: ${nextFilePath}`)
  return nextFilePath
}

async function addImportToNavigationConfig(componentName, screenName) {
  const relativePath = `../${screenName}/screen`
  const importStatement = `import { ${componentName} } from '${relativePath}';\n`

  try {
    let content = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
    if (content.includes(importStatement.trim())) {
      console.log(`Import for ${componentName} already exists in ${NAVIGATION_CONFIG_PATH}`)
      return
    }
    const importRegex = /(import .* from '.*;\n)|(import .* from ".*;\n)/g
    let lastImportIndex = 0
    let match
    while ((match = importRegex.exec(content)) !== null) {
      lastImportIndex = match.index + match[0].length
    }
    if (lastImportIndex > 0) {
      content = content.slice(0, lastImportIndex) + importStatement + content.slice(lastImportIndex)
    } else {
      content = importStatement + content
    }
    ignoreNextConfigChange = true
    await fs.writeFile(NAVIGATION_CONFIG_PATH, content)
    console.log(
      `Added import for ${componentName} to ${NAVIGATION_CONFIG_PATH}. Next direct change will be ignored.`
    )
  } catch (error) {
    console.error(`Error adding import to ${NAVIGATION_CONFIG_PATH}:`, error)
    ignoreNextConfigChange = false
  }
}

async function deleteFeature(screenName) {
  const featurePath = path.join(FEATURES_PATH, screenName)
  if (await fs.pathExists(featurePath)) {
    await fs.remove(featurePath)
    console.log(`Deleted feature directory: ${featurePath}`)
    return featurePath
  }
  console.log(`Feature directory not found, skipped deletion: ${featurePath}`)
  return null
}

async function deleteExpoTabFile(screenName) {
  const expoFilePath = path.join(EXPO_APP_PATH, '(tabs)', `${screenName}.tsx`)
  if (await fs.pathExists(expoFilePath)) {
    await fs.remove(expoFilePath)
    console.log(`Deleted Expo tab file: ${expoFilePath}`)
    return expoFilePath
  }
  console.log(`Expo tab file not found, skipped deletion: ${expoFilePath}`)
  return null
}

async function deleteNextPage(screenName) {
  const nextPageDir = path.join(NEXT_APP_PATH, '(tabs)', screenName)
  if (await fs.pathExists(nextPageDir)) {
    await fs.remove(nextPageDir)
    console.log(`Deleted Next.js page directory: ${nextPageDir}`)
    return nextPageDir
  }
  console.log(`Next.js page directory not found, skipped deletion: ${nextPageDir}`)
  return null
}

async function removeImportFromNavigationConfig(componentName) {
  const importRegex = new RegExp(
    `^import\\s+\\{\\s*${componentName}\\s*\\}\\s+from\\s+['"][^'"]+['"];?\\s*\\n?`,
    'gm'
  )
  try {
    let content = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
    if (importRegex.test(content)) {
      content = content.replace(importRegex, '')
      ignoreNextConfigChange = true
      await fs.writeFile(NAVIGATION_CONFIG_PATH, content)
      console.log(
        `Attempted to remove import for ${componentName} from ${NAVIGATION_CONFIG_PATH}. Next direct change will be ignored.`
      )
    } else {
      console.log(`Import for ${componentName} not found in ${NAVIGATION_CONFIG_PATH}.`)
    }
  } catch (error) {
    console.error(`Error removing import for ${componentName}:`, error)
    ignoreNextConfigChange = false
  }
}

async function onConfigFileChanged(changedPath) {
  if (actionInProgress) {
    console.log('Action already in progress. Will process after current action or on next save.')
    reevaluateAfterCompletion = true
    return
  }
  actionInProgress = true

  try {
    if (changedPath === NAVIGATION_CONFIG_PATH && ignoreNextConfigChange) {
      ignoreNextConfigChange = false
      return
    }

    console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}. Parsing...`)
    const currentConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)

    if (!currentConfig) {
      console.warn('Could not parse navigation config. Waiting for next valid change.')
      return
    }

    const { newScreens, deletedScreens, updatedScreens } = identifyChanges(
      currentConfig,
      lastAcknowledgedConfigState
    )

    let changesMadeInThisRun = false

    // --- Handle Deletions ---
    if (deletedScreens.length > 0) {
      console.log(
        `Detected ${deletedScreens.length} screen(s) for DELETION:`,
        deletedScreens.map((s) => s.name).join(', ')
      )
      const { confirmProcessDeletions } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'confirmProcessDeletions',
          message: `The following screen(s) seem to be removed from config: ${deletedScreens.map((s) => s.name).join(', ')}. Delete associated files?`,
          default: false,
        },
      ])

      if (confirmProcessDeletions) {
        const otherUncommittedChanges = await checkUncommittedChanges()
        if (otherUncommittedChanges.length > 0) {
          const { shouldCommitOthersDel } = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'shouldCommitOthersDel',
              message: 'Other uncommitted changes exist. Commit them first?',
              default: false,
            },
          ])
          if (shouldCommitOthersDel) {
            const { commitMsgDel } = await inquirer.default.prompt([
              { type: 'input', name: 'commitMsgDel', message: 'Commit message for other changes:' },
            ])
            if (commitMsgDel)
              await commitChanges(
                commitMsgDel,
                otherUncommittedChanges.map((f) => f.path)
              )
            else {
              console.log('Commit cancelled for other changes.')
              return
            } // Exit if commit cancelled
          }
        }

        const deletedFilePaths = []
        let allDeletionOpsConfirmed = true

        for (const screen of deletedScreens) {
          console.log(
            `\nProcessing DELETION for screen: ${screen.name} (Component: ${screen.componentName})`
          )
          const deletionOps = [
            {
              name: `Delete feature for ${screen.name}`,
              action: async () => {
                const p = await deleteFeature(screen.name)
                if (p) deletedFilePaths.push(p)
              },
            },
            {
              name: `Delete Expo tab file for ${screen.name}`,
              action: async () => {
                const p = await deleteExpoTabFile(screen.name)
                if (p) deletedFilePaths.push(p)
              },
            },
            {
              name: `Delete Next.js page for ${screen.name}`,
              action: async () => {
                const p = await deleteNextPage(screen.name)
                if (p) deletedFilePaths.push(p)
              },
            },
            {
              name: `Remove import for ${screen.componentName} from config`,
              action: () => removeImportFromNavigationConfig(screen.componentName),
            },
          ]

          for (const op of deletionOps) {
            const { confirmOp } = await inquirer.default.prompt([
              {
                type: 'confirm',
                name: 'confirmOp',
                message: `Confirm DELETION: ${op.name}?`,
                default: true,
              },
            ])
            if (!confirmOp) {
              allDeletionOpsConfirmed = false
              console.log(`Operation "${op.name}" cancelled.`)
              break
            }
            try {
              await op.action()
              changesMadeInThisRun = true
            } catch (error) {
              console.error(`Error during "${op.name}":`, error)
              allDeletionOpsConfirmed = false
              break
            }
          }
          if (!allDeletionOpsConfirmed) break
        }

        if (allDeletionOpsConfirmed && (deletedFilePaths.length > 0 || ignoreNextConfigChange)) {
          console.log('\nDeletion process completed for this batch!')
          const { confirmCommitDeletions } = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmCommitDeletions',
              message: 'Commit these deletions?',
              default: true,
            },
          ])
          if (confirmCommitDeletions) {
            const { commitMessageDeletions } = await inquirer.default.prompt([
              {
                type: 'input',
                name: 'commitMessageDeletions',
                message: 'Enter commit message for deletions:',
              },
            ])
            if (commitMessageDeletions) {
              const filesToCommit = [
                ...new Set([...deletedFilePaths, NAVIGATION_CONFIG_PATH]),
              ].filter(Boolean)
              await commitChanges(commitMessageDeletions, filesToCommit)
            }
          }
          lastAcknowledgedConfigState = currentConfig
        } else if (!allDeletionOpsConfirmed) {
          console.log(
            'Deletion process cancelled. No files were committed. Manual cleanup of partial deletions might be needed.'
          )
          return
        } else {
          console.log(
            "No files were actually deleted (e.g., they didn't exist or import wasn't found)."
          )
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process deletions now. Scheduling re-evaluation.')
        setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
        return
      }
    }

    // --- Handle Updates ---
    if (updatedScreens.length > 0) {
      console.log(
        `Detected ${updatedScreens.length} screen(s) for UPDATE:`,
        updatedScreens
          .map(
            (s) =>
              `${s.newScreen.name} (Old component: ${s.oldScreen.componentName}, New: ${s.newScreen.componentName}; Old title: ${s.oldScreen.title}, New: ${s.newScreen.title})`
          )
          .join('\n')
      )
      const { confirmProcessUpdates } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'confirmProcessUpdates',
          message: `The above screen(s) have updates in the config. Update associated files (will prompt for overwrites)?`,
          default: true,
        },
      ])

      if (confirmProcessUpdates) {
        const otherUncommittedChanges = await checkUncommittedChanges()
        if (otherUncommittedChanges.length > 0) {
          // Simplified Git check
          const { shouldCommitOthersUpd } = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'shouldCommitOthersUpd',
              message: 'Other uncommitted changes exist. Commit them first?',
              default: false,
            },
          ])
          if (shouldCommitOthersUpd) {
            const { commitMsgUpd } = await inquirer.default.prompt([
              { type: 'input', name: 'commitMsgUpd', message: 'Commit message for other changes:' },
            ])
            if (commitMsgUpd)
              await commitChanges(
                commitMsgUpd,
                otherUncommittedChanges.map((f) => f.path)
              )
            else {
              console.log('Commit cancelled.')
              return
            }
          }
        }

        const updatedFilePaths = []
        let allUpdateOpsConfirmed = true

        for (const { oldScreen, newScreen } of updatedScreens) {
          console.log(`\nProcessing UPDATE for screen: ${newScreen.name}`)
          const updateOps = [
            {
              name: `Update feature screen for ${newScreen.name}`,
              action: async () => {
                const p = await generateFeatureScreen(
                  newScreen.name,
                  newScreen.componentName,
                  newScreen.title || newScreen.name,
                  true
                )
                if (p) updatedFilePaths.push(p)
              },
            },
            {
              name: `Update Expo tab file for ${newScreen.name}`,
              action: async () => {
                const p = await generateExpoTabFile(newScreen.name, newScreen.componentName, true)
                if (p) updatedFilePaths.push(p)
              },
            },
            {
              name: `Update Next.js page file for ${newScreen.name}`,
              action: async () => {
                const p = await generateNextPageFile(newScreen.name, newScreen.componentName, true)
                if (p) updatedFilePaths.push(p)
              },
            },
          ]

          // Handle import changes if componentName changed
          if (oldScreen.componentName !== newScreen.componentName) {
            updateOps.push({
              name: `Remove old import for ${oldScreen.componentName}`,
              action: () => removeImportFromNavigationConfig(oldScreen.componentName),
            })
            updateOps.push({
              name: `Add new import for ${newScreen.componentName}`,
              action: () => addImportToNavigationConfig(newScreen.componentName, newScreen.name),
            })
          }

          for (const op of updateOps) {
            const { confirmOp } = await inquirer.default.prompt([
              {
                type: 'confirm',
                name: 'confirmOp',
                message: `Confirm UPDATE: ${op.name}?`,
                default: true,
              },
            ])
            if (!confirmOp) {
              allUpdateOpsConfirmed = false
              console.log(`Operation "${op.name}" cancelled.`)
              break
            }
            try {
              await op.action()
              changesMadeInThisRun = true
            } catch (error) {
              console.error(`Error during "${op.name}":`, error)
              allUpdateOpsConfirmed = false
              break
            }
          }
          if (!allUpdateOpsConfirmed) break
        }

        if (allUpdateOpsConfirmed && (updatedFilePaths.length > 0 || ignoreNextConfigChange)) {
          console.log('\nUpdate process completed for this batch!')
          // Commit changes for updates
          const { confirmCommitUpdates } = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmCommitUpdates',
              message: 'Commit these updates?',
              default: true,
            },
          ])
          if (confirmCommitUpdates) {
            const { commitMessageUpdates } = await inquirer.default.prompt([
              {
                type: 'input',
                name: 'commitMessageUpdates',
                message: 'Enter commit message for updates:',
              },
            ])
            if (commitMessageUpdates) {
              const filesToCommit = [
                ...new Set([...updatedFilePaths, NAVIGATION_CONFIG_PATH]),
              ].filter(Boolean)
              await commitChanges(commitMessageUpdates, filesToCommit)
            }
          }
          lastAcknowledgedConfigState = currentConfig
        } else if (!allUpdateOpsConfirmed) {
          console.log(
            'Update process cancelled. No files were committed. Manual cleanup of partial updates might be needed.'
          )
          return
        } else {
          console.log(
            'No files were actually updated (e.g., all overwrites skipped or no import changes needed).'
          )
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process updates now. Scheduling re-evaluation.')
        setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
        return
      }
    }

    // --- Handle Additions ---
    if (newScreens.length > 0) {
      console.log(
        `Detected ${newScreens.length} screen(s) for ADDITION:`,
        newScreens.map((s) => s.name).join(', ')
      )
      const { confirmProcessAdditions } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'confirmProcessAdditions',
          message: `The following new screen(s) were detected: ${newScreens.map((s) => s.name).join(', ')}. Generate files for them?`,
          default: true,
        },
      ])

      if (confirmProcessAdditions) {
        const otherUncommittedChanges = await checkUncommittedChanges()
        if (otherUncommittedChanges.length > 0) {
          const { shouldCommitOthersAdd } = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'shouldCommitOthersAdd',
              message: 'Other uncommitted changes exist. Commit them first?',
              default: false,
            },
          ])
          if (shouldCommitOthersAdd) {
            const { commitMsgAdd } = await inquirer.default.prompt([
              { type: 'input', name: 'commitMsgAdd', message: 'Commit message for other changes:' },
            ])
            if (commitMsgAdd)
              await commitChanges(
                commitMsgAdd,
                otherUncommittedChanges.map((f) => f.path)
              )
            else {
              console.log('Commit cancelled.')
              return
            }
          }
        }

        const generatedFilePaths = []
        let allAdditionOpsConfirmed = true

        for (const screen of newScreens) {
          console.log(`\nProcessing ADDITION for screen: ${screen.name}`)
          const additionOps = [
            {
              name: `Generate feature screen for ${screen.name}`,
              action: async () => {
                const p = await generateFeatureScreen(
                  screen.name,
                  screen.componentName,
                  screen.title || screen.name
                )
                if (p) generatedFilePaths.push(p)
              },
            },
            {
              name: `Generate Expo tab file for ${screen.name}`,
              action: async () => {
                const p = await generateExpoTabFile(screen.name, screen.componentName)
                if (p) generatedFilePaths.push(p)
              },
            },
            {
              name: `Generate Next.js page file for ${screen.name}`,
              action: async () => {
                const p = await generateNextPageFile(screen.name, screen.componentName)
                if (p) generatedFilePaths.push(p)
              },
            },
            {
              name: `Add import for ${screen.componentName} to config`,
              action: () => addImportToNavigationConfig(screen.componentName, screen.name),
            },
          ]
          for (const op of additionOps) {
            const { confirmOp } = await inquirer.default.prompt([
              {
                type: 'confirm',
                name: 'confirmOp',
                message: `Confirm ADDITION: ${op.name}?`,
                default: true,
              },
            ])
            if (!confirmOp) {
              allAdditionOpsConfirmed = false
              console.log(`Operation "${op.name}" cancelled.`)
              break
            }
            try {
              await op.action()
              changesMadeInThisRun = true
            } catch (error) {
              console.error(`Error during "${op.name}":`, error)
              allAdditionOpsConfirmed = false
              break
            }
          }
          if (!allAdditionOpsConfirmed) break
        }

        if (!allAdditionOpsConfirmed) {
          if (generatedFilePaths.length > 0) {
            console.log(
              'One or more operations were cancelled. Undoing generated files for this batch...'
            )
            for (const filePath of generatedFilePaths) {
              try {
                if (await fs.pathExists(filePath)) {
                  await fs.remove(filePath)
                  console.log(`Removed: ${filePath}`)
                }
              } catch (undoError) {
                console.error(`Error undoing ${filePath}:`, undoError)
              }
            }
          } else {
            console.log('Addition process cancelled, no files to undo.')
          }
          console.log(
            'Aborting addition operations for this batch. Programmatic changes to layout.tsx (if any) might need manual revert.'
          )
          return
        }

        if (generatedFilePaths.length > 0 || ignoreNextConfigChange) {
          console.log('\nFile generation/update process for additions completed!')
          const { confirmAllWork } = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmAllWork',
              message: 'All attempted changes for additions are done. Do they work as expected?',
              default: true,
            },
          ])
          if (confirmAllWork) {
            const { shouldCommitNew } = await inquirer.default.prompt([
              {
                type: 'confirm',
                name: 'shouldCommitNew',
                message: 'Commit these addition changes?',
                default: true,
              },
            ])
            if (shouldCommitNew) {
              const { commitMessageNew } = await inquirer.default.prompt([
                {
                  type: 'input',
                  name: 'commitMessageNew',
                  message: 'Enter commit message for additions:',
                },
              ])
              if (commitMessageNew) {
                const filesToCommit = [
                  ...new Set([...generatedFilePaths, NAVIGATION_CONFIG_PATH]),
                ].filter(Boolean)
                await commitChanges(commitMessageNew, filesToCommit)
              } else {
                console.log('No commit message. Not committing additions.')
              }
            }
          } else {
            console.log(
              'User indicated addition changes might not be working. Please review and commit manually.'
            )
          }
          lastAcknowledgedConfigState = currentConfig
        } else if (allAdditionOpsConfirmed) {
          console.log(
            '\nNo new files were generated for additions (e.g., all existing files were skipped and no imports needed).'
          )
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process additions now. Scheduling re-evaluation.')
        setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
        return
      }
    }

    if (newScreens.length === 0 && deletedScreens.length === 0 && updatedScreens.length === 0) {
      console.log(
        'No actionable changes (new/deleted/updated screens) detected after initial parse.'
      )
      lastAcknowledgedConfigState = currentConfig
    } else if (
      !changesMadeInThisRun &&
      (newScreens.length > 0 || deletedScreens.length > 0 || updatedScreens.length > 0)
    ) {
      // This case might occur if user declined all operations for detected changes.
      // The setImmediate for re-evaluation is already handled in those specific decline paths.
    }

    console.log('Processing cycle completed.')
  } catch (error) {
    console.error('An error occurred during the main processing sequence:', error)
  } finally {
    actionInProgress = false
    if (reevaluateAfterCompletion) {
      reevaluateAfterCompletion = false
      console.log('Re-evaluating config due to changes during previous operation...')
      setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
    }
  }
}

console.log(`Watching for changes in ${NAVIGATION_CONFIG_PATH}...`)
const watcher = chokidar.watch(NAVIGATION_CONFIG_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1500,
    pollInterval: 100,
  },
})

watcher.on('change', (filePath) => onConfigFileChanged(filePath))
watcher.on('error', (error) => console.error(`Watcher error: ${error}`))

parseNavigationConfig(NAVIGATION_CONFIG_PATH)
  .then((config) => {
    if (config) {
      lastAcknowledgedConfigState = config
      console.log('Initial navigation config parsed and stored.')
    } else {
      console.error('Failed to parse initial config on startup. Please check the file.')
    }
  })
  .catch((err) => console.error('Error during initial config parse:', err))

console.log('CLI tool started. Press Ctrl+C to exit.')
