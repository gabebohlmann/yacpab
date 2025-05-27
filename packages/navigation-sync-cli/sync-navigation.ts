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

    const newScreens = []
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
                                    if (optName === 'tabBarIconName') screen.icon = optValue
                                  }
                                })
                              }
                            }
                          })
                          if (screen.name) newScreens.push(screen)
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
    return { screens: newScreens }
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

function identifyNewScreens(currentConfig, previousConfig) {
  if (!currentConfig || !currentConfig.screens) return []
  if (!previousConfig || !previousConfig.screens)
    return currentConfig.screens.filter((s) => s.name && s.componentName)

  const previousScreenNames = new Set(previousConfig.screens.map((s) => s.name))
  return currentConfig.screens.filter(
    (s) => s.name && s.componentName && !previousScreenNames.has(s.name)
  )
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

async function generateFeatureScreen(screenName, componentName, title) {
  const featurePath = path.join(FEATURES_PATH, screenName)
  const screenFilePath = path.join(featurePath, 'screen.tsx')

  if (await fs.pathExists(screenFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Feature screen file already exists: ${screenFilePath}. Overwrite?`,
        default: false,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped overwriting: ${screenFilePath}`)
      return null // Indicate file was not written
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
        This screen was auto-generated by the CLI.
      </Text>
    </View>
  )
}

`
  await fs.writeFile(screenFilePath, content)
  console.log(`Generated: ${screenFilePath}`)
  return screenFilePath
}

async function generateExpoTabFile(screenName, componentName) {
  const expoTabDir = path.join(EXPO_APP_PATH, '(tabs)')
  const expoFilePath = path.join(expoTabDir, `${screenName}.tsx`)

  if (await fs.pathExists(expoFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Expo tab file already exists: ${expoFilePath}. Overwrite?`,
        default: false,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped overwriting: ${expoFilePath}`)
      return null
    }
  }

  await fs.ensureDir(expoTabDir) // Should already exist but good practice
  const content = `// apps/expo/app/(tabs)/${screenName}.tsx
import { ${componentName} } from 'app/features/${screenName}/screen';

export default function ${capitalizeFirstLetter(screenName)}TabPage() {
  return <${componentName} />;
}
`
  await fs.writeFile(expoFilePath, content)
  console.log(`Generated: ${expoFilePath}`)
  return expoFilePath
}

async function generateNextPageFile(screenName, componentName) {
  const nextPageDir = path.join(NEXT_APP_PATH, '(tabs)', screenName)
  const nextFilePath = path.join(nextPageDir, 'page.tsx')

  if (await fs.pathExists(nextFilePath)) {
    // Check if page.tsx exists
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Next.js page file already exists: ${nextFilePath}. Overwrite?`,
        default: false,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped overwriting: ${nextFilePath}`)
      return null
    }
  } else if (await fs.pathExists(nextPageDir)) {
    // Check if directory exists but page.tsx doesn't
    console.log(`Directory ${nextPageDir} exists, but page.tsx will be created.`)
  }

  await fs.ensureDir(nextPageDir)
  const content = `// apps/next/app/(tabs)/${screenName}/page.tsx
'use client';

import { ${componentName} } from 'app/features/${screenName}/screen';

export default function ${capitalizeFirstLetter(screenName)}Page() {
  return <${componentName} />;
}
`
  await fs.writeFile(nextFilePath, content)
  console.log(`Generated: ${nextFilePath}`)
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

async function onConfigFileChanged(changedPath) {
  if (changedPath === NAVIGATION_CONFIG_PATH && ignoreNextConfigChange) {
    // console.log('Change to navigation config was programmatic, ignoring this event.') // User commented this out
    ignoreNextConfigChange = false
    return
  }

  if (actionInProgress) {
    console.log(
      'Action already in progress. Change will be processed after current action completes or on next save.'
    )
    return
  }

  console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}. Parsing...`)
  const currentConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)

  if (!currentConfig) {
    console.warn(
      'Could not parse navigation config or file is invalid. Waiting for next valid change.'
    )
    return
  }

  const newScreens = identifyNewScreens(currentConfig, lastAcknowledgedConfigState)

  if (newScreens.length === 0) {
    console.log('No new screens detected compared to the last acknowledged state.')
    lastAcknowledgedConfigState = currentConfig
    return
  }

  console.log(
    `Detected ${newScreens.length} potential new screen(s):`,
    newScreens.map((s) => s.name).join(', ')
  )

  try {
    const { confirmProcessNow } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirmProcessNow',
        message: `The following new screen(s) were detected: ${newScreens.map((s) => s.name).join(', ')}. Do you want to proceed with generating files and updates for them now?`,
        default: true,
      },
    ])

    if (!confirmProcessNow) {
      console.log(
        'User chose not to process changes now. These changes will be re-evaluated on the next file modification.'
      )
      lastAcknowledgedConfigState = currentConfig
      return
    }

    actionInProgress = true

    const otherUncommittedChanges = await checkUncommittedChanges()
    if (otherUncommittedChanges.length > 0) {
      console.log('Uncommitted changes found (excluding navigation config):')
      otherUncommittedChanges.forEach((f) => console.log(`  - ${f.path} (${f.working_dir})`))
      const { shouldCommitOthers } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'shouldCommitOthers',
          message: 'You have other uncommitted changes. Would you like to commit them first?',
          default: false,
        },
      ])
      if (shouldCommitOthers) {
        const { commitMessageOthers } = await inquirer.default.prompt([
          {
            type: 'input',
            name: 'commitMessageOthers',
            message: 'Enter commit message for other changes:',
          },
        ])
        if (commitMessageOthers) {
          await commitChanges(
            commitMessageOthers,
            otherUncommittedChanges.map((f) => f.path)
          )
        } else {
          console.log('No commit message provided. Aborting current operation.')
          actionInProgress = false
          return
        }
      } else {
        console.log('Proceeding without committing other changes.')
      }
    }

    console.log(`Proceeding with generation for: ${newScreens.map((s) => s.name).join(', ')}.`)
    const generatedFilePaths = [] // Store paths of files actually written or overwritten
    let allOpsForBatchConfirmed = true

    for (const screen of newScreens) {
      if (!screen.name || !screen.componentName || !(screen.title || screen.name)) {
        console.warn(
          `Skipping screen due to missing critical data (name, componentName, or title): ${JSON.stringify(screen)}`
        )
        continue
      }
      console.log(`\nProcessing new screen: ${screen.name}`)

      const operations = [
        {
          name: `Generate feature screen for ${screen.name}`,
          action: async () => {
            const filePath = await generateFeatureScreen(
              screen.name,
              screen.componentName,
              screen.title || screen.name
            )
            if (filePath) generatedFilePaths.push(filePath) // Only add if file was written
          },
        },
        {
          name: `Generate Expo tab file for ${screen.name}`,
          action: async () => {
            const filePath = await generateExpoTabFile(screen.name, screen.componentName)
            if (filePath) generatedFilePaths.push(filePath)
          },
        },
        {
          name: `Generate Next.js page file for ${screen.name}`,
          action: async () => {
            const filePath = await generateNextPageFile(screen.name, screen.componentName)
            if (filePath) generatedFilePaths.push(filePath)
          },
        },
        {
          name: `Add import for ${screen.componentName} to navigation config`,
          action: async () => {
            await addImportToNavigationConfig(screen.componentName, screen.name)
            // This operation doesn't generate a new file path to add to generatedFilePaths for commit,
            // but NAVIGATION_CONFIG_PATH is added to commit list later if changes occurred.
          },
        },
      ]

      for (const op of operations) {
        const { confirmOp } = await inquirer.default.prompt([
          { type: 'confirm', name: 'confirmOp', message: `Confirm: ${op.name}?`, default: true },
        ])
        if (!confirmOp) {
          allOpsForBatchConfirmed = false
          console.log(`Operation "${op.name}" cancelled.`)
          break // Stop operations for this screen
        }
        try {
          await op.action()
        } catch (error) {
          console.error(`Error during "${op.name}":`, error)
          allOpsForBatchConfirmed = false
          break // Stop operations for this screen on error
        }
      }

      if (!allOpsForBatchConfirmed) break // Stop processing further screens if current screen's ops were cancelled
    }

    if (!allOpsForBatchConfirmed && generatedFilePaths.length > 0) {
      // Only undo if files were actually generated
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
      console.log(
        'Aborting operations for this batch. Programmatic changes to layout.tsx (if any) might need manual revert.'
      )
      actionInProgress = false
      return // Exit processing for this detected change event
    }

    // If allOpsForBatchConfirmed is true, or it's false but no files were generated (e.g., user skipped all overwrites)
    // we can proceed to the commit stage if there's anything to commit.

    if (generatedFilePaths.length > 0 || ignoreNextConfigChange) {
      // Check if any file was written or import was added
      console.log('\nFile generation/update process for this batch completed!')
      const { confirmAllWork } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'confirmAllWork',
          message: 'All attempted changes for this batch are done. Do they work as expected?',
          default: true,
        },
      ])

      if (confirmAllWork) {
        const { shouldCommitNew } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'shouldCommitNew',
            message: 'Commit these changes?',
            default: true,
          },
        ])
        if (shouldCommitNew) {
          const { commitMessageNew } = await inquirer.default.prompt([
            { type: 'input', name: 'commitMessageNew', message: 'Enter commit message:' },
          ])
          if (commitMessageNew) {
            // Files to commit: generated files + navigation config if it was changed by adding an import
            const filesToCommit = [
              ...new Set([...generatedFilePaths, NAVIGATION_CONFIG_PATH]),
            ].filter(Boolean)
            if (filesToCommit.length > 0) {
              await commitChanges(commitMessageNew, filesToCommit)
            } else {
              console.log('No files were generated or modified to commit.')
            }
          } else {
            console.log('No commit message. Not committing.')
          }
        }
      } else {
        console.log(
          'User indicated changes might not be working. Please review and commit manually.'
        )
      }
    } else if (allOpsForBatchConfirmed) {
      console.log('\nNo new files were generated (e.g., all existing files were skipped).')
    }

    lastAcknowledgedConfigState = currentConfig
    console.log('Processing for the current batch of screens completed.')
  } catch (error) {
    console.error('An error occurred during the main processing sequence:', error)
  } finally {
    actionInProgress = false
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
