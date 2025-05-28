// packages/navigation-sync-cli/sync-navigation.ts
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
let manualReevaluationScheduledByDecline = false

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
                                    if (optName === 'tabBarIconName') screen.icon = optValue
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
  const updatedScreens = [] // For title/componentName changes on the *same* screen name
  const renamedScreens = [] // For screen *name* changes

  const currentScreenMap = new Map(currentConfig?.screens?.map((s) => [s.name, s]) || [])
  const previousScreenMap = new Map(previousConfig?.screens?.map((s) => [s.name, s]) || [])

  const processedAsRenameNewNames = new Set()
  const processedAsRenameOldNames = new Set()

  // Pass 1: Identify potential renames first
  for (const [prevName, prevScreen] of previousScreenMap) {
    if (!currentScreenMap.has(prevName)) {
      // Potential deletion or rename source
      // Try to find a "new" screen in currentConfig with the same componentName
      for (const [currName, currScreen] of currentScreenMap) {
        if (
          !previousScreenMap.has(currName) && // currScreen is "new"
          currScreen.componentName === prevScreen.componentName &&
          !processedAsRenameNewNames.has(currName)
        ) {
          // And not already matched

          renamedScreens.push({ oldScreen: prevScreen, newScreen: currScreen })
          processedAsRenameOldNames.add(prevName)
          processedAsRenameNewNames.add(currName)
          break // Found a rename match for prevScreen
        }
      }
    }
  }

  // Pass 2: Identify true updates (title/component change for same name)
  for (const [name, currentScreen] of currentScreenMap) {
    if (
      previousScreenMap.has(name) &&
      !processedAsRenameNewNames.has(name) &&
      !processedAsRenameOldNames.has(name)
    ) {
      // Ensure it wasn't part of a rename (where 'name' itself changed)
      const previousScreen = previousScreenMap.get(name)
      if (
        currentScreen.componentName !== previousScreen.componentName ||
        currentScreen.title !== previousScreen.title
      ) {
        updatedScreens.push({ oldScreen: previousScreen, newScreen: currentScreen })
      }
    }
  }

  // Pass 3: Identify true new screens
  for (const [name, currentScreen] of currentScreenMap) {
    if (!previousScreenMap.has(name) && !processedAsRenameNewNames.has(name)) {
      if (currentScreen.name && currentScreen.componentName) {
        newScreens.push(currentScreen)
      }
    }
  }

  // Pass 4: Identify true deleted screens
  for (const [name, previousScreen] of previousScreenMap) {
    if (!currentScreenMap.has(name) && !processedAsRenameOldNames.has(name)) {
      if (previousScreen.name && previousScreen.componentName) {
        deletedScreens.push(previousScreen)
      }
    }
  }

  return { newScreens, deletedScreens, updatedScreens, renamedScreens }
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

async function generateFeatureScreen(screenName, componentName, title, isUpdateOrRename = false) {
  const featurePath = path.join(FEATURES_PATH, screenName)
  const screenFilePath = path.join(featurePath, 'screen.tsx')
  const promptAction = isUpdateOrRename ? 'Update/overwrite' : 'Overwrite'

  if (await fs.pathExists(screenFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Feature screen file already exists: ${screenFilePath}. ${promptAction}?`,
        default: isUpdateOrRename,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped ${isUpdateOrRename ? 'updating' : 'overwriting'}: ${screenFilePath}`)
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
        This screen was ${isUpdateOrRename ? 'updated/regenerated' : 'auto-generated'} by the CLI.
      </Text>
    </View>
  )
}

`
  await fs.writeFile(screenFilePath, content)
  console.log(`${isUpdateOrRename ? 'Updated/Regenerated' : 'Generated'}: ${screenFilePath}`)
  return screenFilePath
}

async function generateExpoTabFile(screenName, componentName, isUpdateOrRename = false) {
  const expoTabDir = path.join(EXPO_APP_PATH, '(tabs)')
  const expoFilePath = path.join(expoTabDir, `${screenName}.tsx`)
  const promptAction = isUpdateOrRename ? 'Update/overwrite' : 'Overwrite'

  if (await fs.pathExists(expoFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Expo tab file already exists: ${expoFilePath}. ${promptAction}?`,
        default: isUpdateOrRename,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped ${isUpdateOrRename ? 'updating' : 'overwriting'}: ${expoFilePath}`)
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
  console.log(`${isUpdateOrRename ? 'Updated/Regenerated' : 'Generated'}: ${expoFilePath}`)
  return expoFilePath
}

async function generateNextPageFile(screenName, componentName, isUpdateOrRename = false) {
  const nextPageDir = path.join(NEXT_APP_PATH, '(tabs)', screenName)
  const nextFilePath = path.join(nextPageDir, 'page.tsx')
  const promptAction = isUpdateOrRename ? 'Update/overwrite' : 'Overwrite'

  if (await fs.pathExists(nextFilePath)) {
    const { overwrite } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Next.js page file already exists: ${nextFilePath}. ${promptAction}?`,
        default: isUpdateOrRename,
      },
    ])
    if (!overwrite) {
      console.log(`Skipped ${isUpdateOrRename ? 'updating' : 'overwriting'}: ${nextFilePath}`)
      return null
    }
  } else if ((await fs.pathExists(nextPageDir)) && !isUpdateOrRename) {
    console.log(`Directory ${nextPageDir} exists, but page.tsx will be created.`)
  } else if (!isUpdateOrRename) {
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
  console.log(`${isUpdateOrRename ? 'Updated/Regenerated' : 'Generated'}: ${nextFilePath}`)
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

// --- Renaming Functions ---
async function renameFeatureDirectory(oldName, newName) {
  const oldPath = path.join(FEATURES_PATH, oldName)
  const newPath = path.join(FEATURES_PATH, newName)
  if (await fs.pathExists(oldPath)) {
    if (await fs.pathExists(newPath)) {
      console.warn(
        `Cannot rename feature directory: target ${newPath} already exists. Please resolve manually or allow overwrite if part of content update.`
      )
      return null // Or prompt to overwrite newPath if it's just a folder
    }
    await fs.rename(oldPath, newPath)
    console.log(`Renamed feature directory from ${oldPath} to ${newPath}`)
    return newPath
  }
  console.log(`Feature directory not found, skipped rename: ${oldPath}`)
  return null
}

async function renameExpoTabFile(oldName, newName) {
  const oldPath = path.join(EXPO_APP_PATH, '(tabs)', `${oldName}.tsx`)
  const newPath = path.join(EXPO_APP_PATH, '(tabs)', `${newName}.tsx`)
  if (await fs.pathExists(oldPath)) {
    if (await fs.pathExists(newPath)) {
      console.warn(`Cannot rename Expo tab file: target ${newPath} already exists.`)
      return null
    }
    await fs.rename(oldPath, newPath)
    console.log(`Renamed Expo tab file from ${oldPath} to ${newPath}`)
    return newPath
  }
  console.log(`Expo tab file not found, skipped rename: ${oldPath}`)
  return null
}

async function renameNextPageDirectory(oldName, newName) {
  const oldPath = path.join(NEXT_APP_PATH, '(tabs)', oldName)
  const newPath = path.join(NEXT_APP_PATH, '(tabs)', newName)
  if (await fs.pathExists(oldPath)) {
    if (await fs.pathExists(newPath)) {
      console.warn(`Cannot rename Next.js page directory: target ${newPath} already exists.`)
      return null
    }
    await fs.rename(oldPath, newPath)
    console.log(`Renamed Next.js page directory from ${oldPath} to ${newPath}`)
    return newPath
  }
  console.log(`Next.js page directory not found, skipped rename: ${oldPath}`)
  return null
}

async function onConfigFileChanged(changedPath) {
  manualReevaluationScheduledByDecline = false

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

    const { newScreens, deletedScreens, updatedScreens, renamedScreens } = identifyChanges(
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
        // ... (Git check logic) ...
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
            /* ... (op confirmation loop) ... */
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
          /* ... (commit logic) ... */ lastAcknowledgedConfigState = currentConfig
        } else if (!allDeletionOpsConfirmed) {
          console.log('Deletion process cancelled.')
          return
        } else {
          console.log('No files actually deleted.')
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process deletions. Scheduling re-evaluation.')
        manualReevaluationScheduledByDecline = true
        setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
        return
      }
    }

    // --- Handle Renames ---
    if (renamedScreens.length > 0) {
      console.log(`Detected ${renamedScreens.length} screen(s) for RENAME:`)
      renamedScreens.forEach((r) =>
        console.log(
          `  - '${r.oldScreen.name}' (component ${r.oldScreen.componentName}) to '${r.newScreen.name}' (component ${r.newScreen.componentName})`
        )
      )

      const { confirmProcessRenames } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'confirmProcessRenames',
          message: `The above screen(s) appear to be renamed. Proceed with renaming files/folders and updating content?`,
          default: true,
        },
      ])

      if (confirmProcessRenames) {
        // ... (Git check logic) ...
        const renamedOrUpdatedFilePaths = []
        let allRenameOpsConfirmed = true

        for (const { oldScreen, newScreen } of renamedScreens) {
          console.log(`\nProcessing RENAME for '${oldScreen.name}' to '${newScreen.name}'`)
          const renameOps = []

          // 1. Rename files/folders
          renameOps.push({
            name: `Rename feature directory for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              await renameFeatureDirectory(
                oldScreen.name,
                newScreen.name
              ) /* Path not added, as it's a move */
            },
          })
          renameOps.push({
            name: `Rename Expo tab file for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              await renameExpoTabFile(oldScreen.name, newScreen.name)
            },
          })
          renameOps.push({
            name: `Rename Next.js page directory for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              await renameNextPageDirectory(oldScreen.name, newScreen.name)
            },
          })

          // 2. Regenerate/Update content in the *newly named* files
          // These will use the newScreen.name, newScreen.componentName, newScreen.title
          renameOps.push({
            name: `Update/regenerate feature screen content for '${newScreen.name}'`,
            action: async () => {
              const p = await generateFeatureScreen(
                newScreen.name,
                newScreen.componentName,
                newScreen.title || newScreen.name,
                true
              )
              if (p) renamedOrUpdatedFilePaths.push(p)
            },
          })
          renameOps.push({
            name: `Update/regenerate Expo tab file content for '${newScreen.name}'`,
            action: async () => {
              const p = await generateExpoTabFile(newScreen.name, newScreen.componentName, true)
              if (p) renamedOrUpdatedFilePaths.push(p)
            },
          })
          renameOps.push({
            name: `Update/regenerate Next.js page file content for '${newScreen.name}'`,
            action: async () => {
              const p = await generateNextPageFile(newScreen.name, newScreen.componentName, true)
              if (p) renamedOrUpdatedFilePaths.push(p)
            },
          })

          // 3. Handle imports if componentName changed (less common for pure rename, but possible)
          if (oldScreen.componentName !== newScreen.componentName) {
            renameOps.push({
              name: `Remove old import for ${oldScreen.componentName}`,
              action: () => removeImportFromNavigationConfig(oldScreen.componentName),
            })
            renameOps.push({
              name: `Add new import for ${newScreen.componentName}`,
              action: () => addImportToNavigationConfig(newScreen.componentName, newScreen.name),
            })
          }
          // If only name changed, existing import for oldScreen.componentName is fine as it points to the component, not the file path.

          for (const op of renameOps) {
            const { confirmOp } = await inquirer.default.prompt([
              {
                type: 'confirm',
                name: 'confirmOp',
                message: `Confirm RENAME action: ${op.name}?`,
                default: true,
              },
            ])
            if (!confirmOp) {
              allRenameOpsConfirmed = false
              console.log(`Operation "${op.name}" cancelled.`)
              break
            }
            try {
              await op.action()
              changesMadeInThisRun = true
            } catch (error) {
              console.error(`Error during "${op.name}":`, error)
              allRenameOpsConfirmed = false
              break
            }
          }
          if (!allRenameOpsConfirmed) break
        }

        if (
          allRenameOpsConfirmed &&
          (renamedOrUpdatedFilePaths.length > 0 || ignoreNextConfigChange)
        ) {
          console.log('\nRename process completed!')
          // ... (Commit logic) ...
          lastAcknowledgedConfigState = currentConfig
        } else if (!allRenameOpsConfirmed) {
          console.log('Rename process cancelled. Manual cleanup might be needed.')
          return
        } else {
          console.log(
            "No files were actually renamed/updated (e.g., targets didn't exist or overwrites skipped)."
          )
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process renames now. Scheduling re-evaluation.')
        manualReevaluationScheduledByDecline = true
        setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
        return
      }
    }

    // --- Handle Updates (title/componentName changes for same screen name) ---
    if (updatedScreens.length > 0) {
      console.log(
        `Detected ${updatedScreens.length} screen(s) for UPDATE (title/component):`,
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
          message: `The above screen(s) have updates in the config. Update associated files?`,
          default: true,
        },
      ])
      if (confirmProcessUpdates) {
        // ... (Git check logic) ...
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
            /* ... (op confirmation loop) ... */
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
          /* ... (commit logic) ... */ lastAcknowledgedConfigState = currentConfig
        } else if (!allUpdateOpsConfirmed) {
          console.log('Update process cancelled.')
          return
        } else {
          console.log('No files actually updated.')
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process updates. Scheduling re-evaluation.')
        manualReevaluationScheduledByDecline = true
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
        // ... (Git check logic) ...
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
            /* ... (op confirmation loop) ... */
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
            /* ... undo logic ... */
          }
          console.log('Addition process cancelled.')
          return
        }
        if (generatedFilePaths.length > 0 || ignoreNextConfigChange) {
          /* ... (commit logic) ... */ lastAcknowledgedConfigState = currentConfig
        } else if (allAdditionOpsConfirmed) {
          console.log('\nNo new files were generated for additions.')
          lastAcknowledgedConfigState = currentConfig
        }
      } else {
        console.log('User chose not to process additions. Scheduling re-evaluation.')
        manualReevaluationScheduledByDecline = true
        setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
        return
      }
    }

    if (
      newScreens.length === 0 &&
      deletedScreens.length === 0 &&
      updatedScreens.length === 0 &&
      renamedScreens.length === 0
    ) {
      console.log(
        'No actionable changes (new/deleted/updated/renamed screens) detected relative to the last acknowledged state.'
      )
      lastAcknowledgedConfigState = currentConfig
    } else if (
      !changesMadeInThisRun &&
      (newScreens.length > 0 ||
        deletedScreens.length > 0 ||
        updatedScreens.length > 0 ||
        renamedScreens.length > 0)
    ) {
      console.log(
        'Detected changes were presented, but no file operations were performed by user choice.'
      )
    }

    console.log('Processing cycle completed.')
  } catch (error) {
    console.error('An error occurred during the main processing sequence:', error)
  } finally {
    actionInProgress = false
    if (reevaluateAfterCompletion && !manualReevaluationScheduledByDecline) {
      reevaluateAfterCompletion = false
      console.log('Re-evaluating config due to changes during an active operation...')
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
