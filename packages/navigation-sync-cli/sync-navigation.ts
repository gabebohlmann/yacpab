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

let editingModeActive = false

function capitalizeFirstLetter(string) {
  if (!string) return ''
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

    let isAutoSaveOn = false
    let isEditing = false
    const parsedScreens = []
    let commandsToExecute = { add: [], delete: [] } // Default empty commands

    function visit(node) {
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach((declaration) => {
          if (ts.isIdentifier(declaration.name)) {
            const varName = declaration.name.text
            if (declaration.initializer) {
              if (varName === 'isAutoSaveOn' || varName === 'isAutoSaveEnabled') {
                isAutoSaveOn = declaration.initializer.kind === ts.SyntaxKind.TrueKeyword
              } else if (varName === 'isEditing') {
                isEditing = declaration.initializer.kind === ts.SyntaxKind.TrueKeyword
              } else if (
                varName === 'commandsToExecute' &&
                ts.isObjectLiteralExpression(declaration.initializer)
              ) {
                declaration.initializer.properties.forEach((prop) => {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                    const commandType = prop.name.text // 'add' or 'delete'
                    if (
                      (commandType === 'add' || commandType === 'delete') &&
                      ts.isArrayLiteralExpression(prop.initializer)
                    ) {
                      commandsToExecute[commandType] = [] // Initialize if not already
                      prop.initializer.elements.forEach((elementNode) => {
                        if (ts.isObjectLiteralExpression(elementNode)) {
                          const commandArg = {}
                          elementNode.properties.forEach((cmdProp) => {
                            if (ts.isPropertyAssignment(cmdProp) && ts.isIdentifier(cmdProp.name)) {
                              const cmdPropName = cmdProp.name.text
                              // Assuming string values for simplicity, add more type checks if needed
                              if (
                                ts.isStringLiteral(cmdProp.initializer) ||
                                ts.isIdentifier(cmdProp.initializer)
                              ) {
                                commandArg[cmdPropName] = cmdProp.initializer.text
                              }
                            }
                          })
                          if (Object.keys(commandArg).length > 0) {
                            commandsToExecute[commandType].push(commandArg)
                          }
                        }
                      })
                    }
                  }
                })
              }
            }
          }
        })
      }

      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.name.getText(sourceFile) === 'appNavigationStructure') {
            // ... (appNavigationStructure parsing logic - unchanged) ...
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
    return { screens: parsedScreens, isAutoSaveOn, isEditing, commandsToExecute }
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

function identifyChanges(currentConfigScreens, previousConfigScreens) {
  const newScreens = []
  const deletedScreens = []
  const updatedScreens = []
  const renamedScreens = []

  const currentScreenMap = new Map(currentConfigScreens?.map((s) => [s.name, s]) || [])
  const previousScreenMap = new Map(previousConfigScreens?.map((s) => [s.name, s]) || [])

  const processedAsRenameNewNames = new Set()
  const processedAsRenameOldNames = new Set()

  for (const [prevName, prevScreen] of previousScreenMap) {
    if (!currentScreenMap.has(prevName)) {
      for (const [currName, currScreen] of currentScreenMap) {
        if (
          !previousScreenMap.has(currName) &&
          currScreen.componentName === prevScreen.componentName &&
          !processedAsRenameNewNames.has(currName)
        ) {
          renamedScreens.push({ oldScreen: prevScreen, newScreen: currScreen })
          processedAsRenameOldNames.add(prevName)
          processedAsRenameNewNames.add(currName)
          break
        }
      }
    }
  }

  for (const [name, currentScreen] of currentScreenMap) {
    if (
      previousScreenMap.has(name) &&
      !processedAsRenameNewNames.has(name) &&
      !processedAsRenameOldNames.has(name)
    ) {
      const previousScreen = previousScreenMap.get(name)
      if (
        currentScreen.componentName !== previousScreen.componentName ||
        currentScreen.title !== previousScreen.title
      ) {
        updatedScreens.push({ oldScreen: previousScreen, newScreen: currentScreen })
      }
    }
  }

  for (const [name, currentScreen] of currentScreenMap) {
    if (!previousScreenMap.has(name) && !processedAsRenameNewNames.has(name)) {
      if (currentScreen.name && currentScreen.componentName) {
        newScreens.push(currentScreen)
      }
    }
  }

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

async function renameFeatureDirectory(oldName, newName) {
  const oldPath = path.join(FEATURES_PATH, oldName)
  const newPath = path.join(FEATURES_PATH, newName)
  if (await fs.pathExists(oldPath)) {
    if (await fs.pathExists(newPath)) {
      console.warn(
        `Cannot rename feature directory: target ${newPath} already exists. Please resolve manually or allow overwrite if part of content update.`
      )
      return null
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

// New function to apply commands from layout.tsx to a screens array
function applyCliCommandsToScreenArray(currentScreens, commands) {
  let screensAfterCommands = [...currentScreens] // Start with a copy

  // Apply deletions first
  if (commands.delete && commands.delete.length > 0) {
    const namesToDelete = new Set(commands.delete.map((cmd) => cmd.name))
    screensAfterCommands = screensAfterCommands.filter((s) => !namesToDelete.has(s.name))
    console.log(
      `Applied in-memory deletions for: ${[...namesToDelete].join(', ')} from commandsToExecute.`
    )
  }

  // Apply additions
  if (commands.add && commands.add.length > 0) {
    commands.add.forEach((cmd) => {
      if (cmd.name && cmd.componentName) {
        // Basic validation
        // Avoid adding if already exists (e.g., from direct edit + command)
        if (!screensAfterCommands.find((s) => s.name === cmd.name)) {
          screensAfterCommands.push({
            name: cmd.name,
            componentName: cmd.componentName,
            title: cmd.title || capitalizeFirstLetter(cmd.name),
            icon: cmd.icon || cmd.name.toLowerCase(),
            // Add other default fields if your ScreenConfig expects them
          })
          console.log(`Applied in-memory addition for: ${cmd.name} from commandsToExecute.`)
        } else {
          console.log(
            `Skipped adding ${cmd.name} from command; screen already exists in current edits.`
          )
        }
      }
    })
  }
  return screensAfterCommands
}

// New function to rewrite layout.tsx with cleared commands and potentially modified appNavigationStructure
async function updateLayoutFileAfterCommands(originalContent, modifiedScreensArray) {
  let newContent = originalContent

  // 1. Regenerate the appNavigationStructure's screens array part based on modifiedScreensArray
  // This is the most complex part with string manipulation.
  // For simplicity, this example will be very basic and might need robust AST-based modification.
  // It assumes a very specific formatting of the screens array.
  const screensArrayString = modifiedScreensArray
    .map(
      (s) =>
        `          {\n            name: '${s.name}',\n            component: ${s.componentName},\n            options: {\n              title: '${s.title || capitalizeFirstLetter(s.name)}',\n              tabBarIconName: '${s.icon || s.name.toLowerCase()}',\n            },\n          }`
    )
    .join(',\n')

  const appNavRegex =
    /(const appNavigationStructure:[^[]*\[[\s\S]*?type:\s*['"`]tabs['"`][\s\S]*?screens:\s*\[)([\s\S]*?)(\s*\][\s\S]*?\}\s*\]\s*;)/m

  if (newContent.match(appNavRegex)) {
    newContent = newContent.replace(appNavRegex, `$1\n${screensArrayString}\n$3`)
    console.log('Programmatically updated appNavigationStructure in layout.tsx content.')
  } else {
    console.warn(
      "Could not find appNavigationStructure's screens array to update programmatically for commands. Manual update might be needed if commands modified screen list."
    )
  }

  // 2. Clear commandsToExecute
  const commandsRegex = /(export\s+const\s+commandsToExecute\s*=\s*\{)([\s\S]*?)(\};)/m
  const clearedCommands = `$1
    add: [
      // Commands processed
    ],
    delete: [
      // Commands processed
    ]
  $3`
  if (newContent.match(commandsRegex)) {
    newContent = newContent.replace(commandsRegex, clearedCommands)
    console.log('Cleared commandsToExecute in layout.tsx content.')
  } else {
    console.warn("Could not find commandsToExecute to clear. Ensure it's defined as expected.")
  }

  ignoreNextConfigChange = true
  await fs.writeFile(NAVIGATION_CONFIG_PATH, newContent)
  console.log('layout.tsx updated after processing commandsToExecute.')
}

async function processBatchOfChanges(configToProcessScreens) {
  if (actionInProgress) {
    console.warn(
      'processBatchOfChanges called while actionInProgress was already true. This is unexpected.'
    )
    reevaluateAfterCompletion = true
    return
  }
  actionInProgress = true

  try {
    const { newScreens, deletedScreens, updatedScreens, renamedScreens } = identifyChanges(
      configToProcessScreens,
      lastAcknowledgedConfigState?.screens
    )

    const hasAnyChanges =
      newScreens.length > 0 ||
      deletedScreens.length > 0 ||
      updatedScreens.length > 0 ||
      renamedScreens.length > 0

    if (!hasAnyChanges) {
      console.log('No actionable screen changes to process relative to last acknowledged state.')
      lastAcknowledgedConfigState = { screens: configToProcessScreens }
      return
    }

    let promptMessage = 'The following changes are detected based on your latest edits:\n'
    if (deletedScreens.length > 0)
      promptMessage += `  - DELETIONS: ${deletedScreens.map((s) => s.name).join(', ')}\n`
    if (renamedScreens.length > 0)
      promptMessage += `  - RENAMES: ${renamedScreens.map((r) => `'${r.oldScreen.name}' to '${r.newScreen.name}'`).join(', ')}\n`
    if (updatedScreens.length > 0)
      promptMessage += `  - UPDATES (title/component): ${updatedScreens.map((u) => u.newScreen.name).join(', ')}\n`
    if (newScreens.length > 0)
      promptMessage += `  - ADDITIONS: ${newScreens.map((s) => s.name).join(', ')}\n`
    promptMessage += 'Do you want to proceed with these changes now?'

    const { confirmProcessNow } = await inquirer.default.prompt([
      { type: 'confirm', name: 'confirmProcessNow', message: promptMessage, default: true },
    ])

    if (!confirmProcessNow) {
      console.log(
        'User chose not to process accumulated changes now. Edits remain, will re-evaluate on next save if isEditing becomes false or autosave is off.'
      )
      return
    }

    let changesEffectivelyMade = false

    // --- Handle Deletions ---
    if (deletedScreens.length > 0) {
      const otherUncommittedChangesDel = await checkUncommittedChanges()
      if (otherUncommittedChangesDel.length > 0) {
        /* Git check */
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
            changesEffectivelyMade = true
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
          /* Commit logic */
        }
      } else if (!allDeletionOpsConfirmed) {
        console.log('Deletion process cancelled.')
        return
      } else {
        console.log('No files actually deleted for deletion batch.')
      }
    }

    // --- Handle Renames ---
    if (renamedScreens.length > 0) {
      const otherUncommittedChangesRen = await checkUncommittedChanges()
      if (otherUncommittedChangesRen.length > 0) {
        /* Git check */
      }

      const renamedOrUpdatedFilePaths = []
      let allRenameOpsConfirmed = true
      for (const { oldScreen, newScreen } of renamedScreens) {
        console.log(`\nProcessing RENAME for '${oldScreen.name}' to '${newScreen.name}'`)
        const renameOps = [
          {
            name: `Rename feature directory for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              await renameFeatureDirectory(oldScreen.name, newScreen.name)
            },
          },
          {
            name: `Rename Expo tab file for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              await renameExpoTabFile(oldScreen.name, newScreen.name)
            },
          },
          {
            name: `Rename Next.js page directory for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              await renameNextPageDirectory(oldScreen.name, newScreen.name)
            },
          },
          {
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
          },
          {
            name: `Update/regenerate Expo tab file content for '${newScreen.name}'`,
            action: async () => {
              const p = await generateExpoTabFile(newScreen.name, newScreen.componentName, true)
              if (p) renamedOrUpdatedFilePaths.push(p)
            },
          },
          {
            name: `Update/regenerate Next.js page file content for '${newScreen.name}'`,
            action: async () => {
              const p = await generateNextPageFile(newScreen.name, newScreen.componentName, true)
              if (p) renamedOrUpdatedFilePaths.push(p)
            },
          },
        ]
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
            changesEffectivelyMade = true
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
        const { confirmCommitRenames } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmCommitRenames',
            message: 'Commit these renames/updates?',
            default: true,
          },
        ])
        if (confirmCommitRenames) {
          /* Commit logic */
        }
      } else if (!allRenameOpsConfirmed) {
        console.log('Rename process cancelled.')
        return
      } else {
        console.log('No files actually renamed/updated for rename batch.')
      }
    }

    // --- Handle Updates (title/componentName changes for same screen name) ---
    if (updatedScreens.length > 0) {
      const otherUncommittedChangesUpd = await checkUncommittedChanges()
      if (otherUncommittedChangesUpd.length > 0) {
        /* Git check */
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
            changesEffectivelyMade = true
          } catch (error) {
            console.error(`Error during "${op.name}":`, error)
            allUpdateOpsConfirmed = false
            break
          }
        }
        if (!allUpdateOpsConfirmed) break
      }
      if (allUpdateOpsConfirmed && (updatedFilePaths.length > 0 || ignoreNextConfigChange)) {
        console.log('\nUpdate process completed!')
        const { confirmCommitUpdates } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmCommitUpdates',
            message: 'Commit these updates?',
            default: true,
          },
        ])
        if (confirmCommitUpdates) {
          /* Commit logic */
        }
      } else if (!allUpdateOpsConfirmed) {
        console.log('Update process cancelled.')
        return
      } else {
        console.log('No files actually updated for update batch.')
      }
    }

    // --- Handle Additions ---
    if (newScreens.length > 0) {
      const otherUncommittedChangesAdd = await checkUncommittedChanges()
      if (otherUncommittedChangesAdd.length > 0) {
        /* Git check */
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
            changesEffectivelyMade = true
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
            /* Commit logic */
          }
        }
      } else if (allAdditionOpsConfirmed) {
        console.log('\nNo new files were generated for additions.')
      }
    }

    if (changesEffectivelyMade || hasAnyChanges) {
      lastAcknowledgedConfigState = { screens: configToProcessScreens }
      console.log(
        "Snapshot `lastAcknowledgedConfigState` updated to current processed config's screens."
      )
    }
  } catch (error) {
    console.error('An error occurred during processBatchOfChanges:', error)
  } finally {
    actionInProgress = false
    if (reevaluateAfterCompletion) {
      reevaluateAfterCompletion = false
      console.log('Re-evaluating config due to changes during the batch operation...')
      setImmediate(() => onConfigFileChanged(NAVIGATION_CONFIG_PATH))
    }
  }
}

async function onConfigFileChanged(changedPath) {
  if (actionInProgress) {
    console.log(
      'An operation batch is already in progress. Queuing re-evaluation for after completion...'
    )
    reevaluateAfterCompletion = true
    return
  }

  if (changedPath === NAVIGATION_CONFIG_PATH && ignoreNextConfigChange) {
    ignoreNextConfigChange = false
    return
  }

  console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}. Parsing...`)
  const parsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)

  if (!parsedResult) {
    console.warn('Could not parse navigation config. Waiting for next valid change.')
    editingModeActive = false
    return
  }

  let { screens: currentScreensFromFile, isAutoSaveOn, isEditing, commandsToExecute } = parsedResult
  console.log(`Parsed flags from file: isAutoSaveOn=${isAutoSaveOn}, isEditing=${isEditing}`)
  if (
    commandsToExecute &&
    (commandsToExecute.add?.length > 0 || commandsToExecute.delete?.length > 0)
  ) {
    console.log(
      `Parsed commands from file: add: ${commandsToExecute.add?.length || 0}, delete: ${commandsToExecute.delete?.length || 0}`
    )
  }

  if (isAutoSaveOn) {
    if (isEditing) {
      if (!editingModeActive) {
        console.log(
          'Autosave ON and `isEditing` is true. Entering editing mode. Waiting for `isEditing` to become false in layout.tsx to process changes.'
        )
        editingModeActive = true
      } else {
        console.log(
          'Autosave ON and `isEditing` is true. Still in editing mode, waiting for `isEditing` to become false.'
        )
      }
      return
    } else {
      // isAutoSaveOn is true, AND isEditing is now false
      if (editingModeActive) {
        console.log('`isEditing` is now false. Processing changes (including any commands).')
        editingModeActive = false
      } else {
        console.log(
          'Autosave ON, `isEditing` is false. Processing changes (including any commands).'
        )
      }
    }
  } else {
    // isAutoSaveOn is false, process immediately
    if (editingModeActive) {
      // Should not happen if isAutoSaveOn is false, but as a safeguard
      console.log('Autosave turned OFF. Exiting editing mode and processing changes.')
      editingModeActive = false
    }
  }

  // Apply commands from layout.tsx if any, before identifying changes against lastAcknowledgedConfigState
  if (
    commandsToExecute &&
    (commandsToExecute.add?.length > 0 || commandsToExecute.delete?.length > 0)
  ) {
    console.log('Applying commands from `commandsToExecute` in layout.tsx...')
    const originalFileContent = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
    const screensAfterCommands = applyCliCommandsToScreenArray(
      currentScreensFromFile,
      commandsToExecute
    )

    // Update layout.tsx to reflect these command-driven changes and clear commands
    await updateLayoutFileAfterCommands(originalFileContent, screensAfterCommands)

    // Re-parse to get the definitive state after programmatic changes
    const finalParsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (!finalParsedResult || !finalParsedResult.screens) {
      console.error('Failed to re-parse layout.tsx after applying commands. Aborting.')
      return
    }
    currentScreensFromFile = finalParsedResult.screens // Use this for processBatchOfChanges
    // The save by updateLayoutFileAfterCommands would have set ignoreNextConfigChange,
    // so the watcher won't immediately re-trigger onConfigFileChanged for that write.
    // We then proceed to processBatchOfChanges with the result.
  }

  await processBatchOfChanges(currentScreensFromFile)
}

// --- Main Execution (CLI command parsing) ---
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const screenNameArg = args[1]

  try {
    const initialConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (initialConfig && initialConfig.screens) {
      lastAcknowledgedConfigState = { screens: initialConfig.screens }
      console.log('Initial navigation config (screens part) parsed and stored for CLI session.')
    } else {
      console.error('Failed to parse initial config for CLI session. Please check the file.')
      lastAcknowledgedConfigState = { screens: [] }
    }
  } catch (err) {
    console.error('Error during initial config parse for CLI session:', err)
    lastAcknowledgedConfigState = { screens: [] }
  }

  if (command === 'add') {
    if (!screenNameArg) {
      console.error(
        "Please provide a screen name for the 'add' command. Usage: sync-nav add <ScreenName>"
      )
      process.exit(1)
    }
    await handleAddCommand(screenNameArg)
  } else if (command === 'delete') {
    if (!screenNameArg) {
      console.error(
        "Please provide a screen name for the 'delete' command. Usage: sync-nav delete <ScreenName>"
      )
      process.exit(1)
    }
    await handleDeleteCommand(screenNameArg)
  } else if (command) {
    console.log(
      `Unknown command: ${command}. Available commands: add, delete. Or run without commands for watcher mode.`
    )
    process.exit(1)
  } else {
    // --- Watcher Setup (Default mode) ---
    console.log(`Watching for changes in ${NAVIGATION_CONFIG_PATH}...`)
    const watcher = chokidar.watch(NAVIGATION_CONFIG_PATH, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    })

    watcher.on('change', (filePath) => onConfigFileChanged(filePath))
    watcher.on('error', (error) => console.error(`Watcher error: ${error}`))

    if (lastAcknowledgedConfigState && lastAcknowledgedConfigState.screens) {
      parseNavigationConfig(NAVIGATION_CONFIG_PATH).then((currentFlagsConfig) => {
        if (currentFlagsConfig) {
          console.log(
            `Initial flags for watcher: isAutoSaveOn=${currentFlagsConfig.isAutoSaveOn}, isEditing=${currentFlagsConfig.isEditing}`
          )
          if (currentFlagsConfig.isAutoSaveOn && currentFlagsConfig.isEditing) {
            editingModeActive = true
            console.log(
              'Started in editing mode due to initial flags in config file (watcher mode).'
            )
          }
        }
      })
    }
    console.log('CLI tool started in watcher mode. Press Ctrl+C to exit.')
  }
}

async function handleAddCommand(screenNameFromArg) {
  console.log(`Preparing to add screen: ${screenNameFromArg}`)
  // No actionInProgress lock here, processBatchOfChanges will handle its own.

  let name = screenNameFromArg.toLowerCase()
  let componentName = capitalizeFirstLetter(name) + 'Screen'
  let title = capitalizeFirstLetter(name)
  let icon = name.toLowerCase()

  const defaultConfigString = `
  {
    name: '${name}',
    component: ${componentName},
    options: {
      title: '${title}',
      tabBarIconName: '${icon}',
    },
  },`

  console.log('\nDefault configuration for the new screen:')
  console.log(defaultConfigString)

  const { confirmDefault } = await inquirer.default.prompt([
    {
      type: 'confirm',
      name: 'confirmDefault',
      message: 'Is this default configuration okay?',
      default: true,
    },
  ])

  if (!confirmDefault) {
    const answers = await inquirer.default.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter screen name (lowercase, for file paths):',
        default: name,
      },
      {
        type: 'input',
        name: 'componentName',
        message: 'Enter ComponentName (e.g., MyScreenComponent):',
        default: componentName,
      },
      {
        type: 'input',
        name: 'title',
        message: 'Enter screen title (for header/tab label):',
        default: title,
      },
      {
        type: 'input',
        name: 'icon',
        message: 'Enter tabBarIconName (e.g., home, settings):',
        default: icon,
      },
    ])
    name = answers.name
    componentName = answers.componentName
    title = answers.title
    icon = answers.icon
  }

  const newScreenObjectString = `\n          {\n            name: '${name}',\n            component: ${componentName},\n            options: {\n              title: '${title}',\n              tabBarIconName: '${icon}',\n            },\n          },`

  try {
    let content = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
    const screensArrayRegex = /(name:\s*['"`]\(tabs\)['"`][\s\S]*?screens:\s*\[)([\s\S]*?)(\s*\])/m
    const match = content.match(screensArrayRegex)

    if (match && match[2] !== undefined && match[3] !== undefined) {
      const beforeArrayContent = match[1]
      let arrayContent = match[2].trim() // Trim to handle trailing commas correctly
      const afterArrayContent = match[3]

      if (arrayContent.length > 0 && !arrayContent.endsWith(',')) {
        arrayContent += ','
      }
      const newArrayContentWithScreen = arrayContent + newScreenObjectString
      content = content.replace(
        screensArrayRegex,
        `${beforeArrayContent}${newArrayContentWithScreen}${afterArrayContent}`
      )

      const importToAdd = `import { ${componentName} } from '../${name}/screen';\n`
      if (!content.includes(importToAdd.trim())) {
        const importRegexGlobal = /(import .* from '.*;\n)|(import .* from ".*;\n)/g
        let lastImportIdx = 0
        let importMatch
        while ((importMatch = importRegexGlobal.exec(content)) !== null) {
          lastImportIdx = importMatch.index + importMatch[0].length
        }
        if (lastImportIdx > 0) {
          content = content.slice(0, lastImportIdx) + importToAdd + content.slice(lastImportIdx)
        } else {
          const firstCodeLineMatch = content.match(
            /^([ \t]*\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*|^[ \t]*\n)*([ \t]*[^\s\n])/m
          )
          const insertPosition = firstCodeLineMatch
            ? firstCodeLineMatch.index + (firstCodeLineMatch[1]?.length || 0)
            : 0
          content = content.slice(0, insertPosition) + importToAdd + content.slice(insertPosition)
        }
      }

      // For direct CLI commands, we don't need ignoreNextConfigChange for the watcher,
      // as the watcher isn't running. We write, then immediately process.
      await fs.writeFile(NAVIGATION_CONFIG_PATH, content)
      console.log(`Screen '${name}' and its import added to ${NAVIGATION_CONFIG_PATH}.`)

      const updatedParsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
      if (updatedParsedResult && updatedParsedResult.screens) {
        // lastAcknowledgedConfigState was set at the start of main()
        await processBatchOfChanges(updatedParsedResult.screens)
      } else {
        console.error('Failed to parse config after adding screen. Aborting processing.')
      }
    } else {
      console.error('Could not find the (tabs) screens array in layout.tsx. Please add manually.')
    }
  } catch (error) {
    console.error('Error updating layout.tsx:', error)
  }
  // No finally block for actionInProgress here, as it's managed by processBatchOfChanges
}

async function handleDeleteCommand(screenNameToDelete) {
  console.log(`Preparing to delete screen: ${screenNameToDelete}`)
  // No actionInProgress lock here

  try {
    let content = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
    const parsedCurrent = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    const screenToDelete = parsedCurrent?.screens.find((s) => s.name === screenNameToDelete)

    if (!screenToDelete) {
      console.error(`Screen '${screenNameToDelete}' not found in navigation config.`)
      return
    }
    const componentNameToRemove = screenToDelete.componentName

    const screenObjectRegex = new RegExp(
      `\\{\\s*name:\\s*['"\`]${screenNameToDelete}['"\`][\\s\\S]*?\\}(,)?`,
      'm'
    )

    let foundAndRemoved = false
    content = content.replace(screenObjectRegex, (match, p1_comma) => {
      foundAndRemoved = true
      return ''
    })

    if (foundAndRemoved) {
      content = content.replace(/,\s*,/g, ',') // Clean up double commas
      content = content.replace(/,\s*\]/g, ']')
      content = content.replace(/\[\s*,/g, '[')

      if (componentNameToRemove) {
        const importRegex = new RegExp(
          `^import\\s+\\{\\s*${componentNameToRemove}\\s*\\}\\s+from\\s+['"][^'"]+['"];?\\s*\\n?`,
          'gm'
        )
        content = content.replace(importRegex, '')
      }

      await fs.writeFile(NAVIGATION_CONFIG_PATH, content)
      console.log(
        `Screen '${screenNameToDelete}' and its import removed from ${NAVIGATION_CONFIG_PATH}.`
      )

      const updatedParsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
      if (updatedParsedResult && updatedParsedResult.screens) {
        await processBatchOfChanges(updatedParsedResult.screens)
      } else {
        console.error('Failed to parse config after deleting screen. Aborting processing.')
      }
    } else {
      console.error(
        `Could not properly remove screen '${screenNameToDelete}' from layout.tsx. Please check manually.`
      )
    }
  } catch (error) {
    console.error('Error updating layout.tsx for deletion:', error)
  }
  // No finally block for actionInProgress here
}

main().catch((err) => {
  console.error('Unhandled error in main execution:', err)
  process.exit(1)
})
