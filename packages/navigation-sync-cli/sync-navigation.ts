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

// --- AST Helper Functions ---
function findAppNavigationStructureDeclaration(sourceFile) {
  let appNavDeclaration = null
  function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'appNavigationStructure') {
          appNavDeclaration = decl
          break
        }
      }
    }
    if (!appNavDeclaration) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return appNavDeclaration
}

function findTabsScreensArrayNodeFromDeclaration(appNavDeclaration) {
  if (
    !appNavDeclaration ||
    !appNavDeclaration.initializer ||
    !ts.isArrayLiteralExpression(appNavDeclaration.initializer)
  )
    return undefined
  const appNavStructureNode = appNavDeclaration.initializer

  if (!appNavStructureNode.elements.length) return undefined
  const rootStackObject = appNavStructureNode.elements[0]
  if (!ts.isObjectLiteralExpression(rootStackObject)) return undefined

  const rootScreensProperty = rootStackObject.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'screens'
  )
  if (
    !rootScreensProperty ||
    !ts.isPropertyAssignment(rootScreensProperty) ||
    !ts.isArrayLiteralExpression(rootScreensProperty.initializer)
  )
    return undefined

  const tabsNavigatorObject = rootScreensProperty.initializer.elements.find(
    (el) =>
      ts.isObjectLiteralExpression(el) &&
      el.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'type' &&
          ts.isStringLiteral(p.initializer) &&
          p.initializer.text === 'tabs'
      ) &&
      el.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'name' &&
          ts.isStringLiteral(p.initializer) &&
          p.initializer.text === '(tabs)'
      )
  )
  if (!tabsNavigatorObject || !ts.isObjectLiteralExpression(tabsNavigatorObject)) return undefined

  const tabScreensProperty = tabsNavigatorObject.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'screens'
  )
  if (
    !tabScreensProperty ||
    !ts.isPropertyAssignment(tabScreensProperty) ||
    !ts.isArrayLiteralExpression(tabScreensProperty.initializer)
  )
    return undefined

  return tabScreensProperty.initializer
}

function createScreenAstNode(factory, screenDetails) {
  // Ensure multiLine is true for the main object and the options object
  // to encourage the printer to use newlines and indentation.
  return factory.createObjectLiteralExpression(
    [
      factory.createPropertyAssignment('name', factory.createStringLiteral(screenDetails.name)),
      factory.createPropertyAssignment(
        'component',
        factory.createIdentifier(screenDetails.componentName)
      ),
      factory.createPropertyAssignment(
        'options',
        factory.createObjectLiteralExpression(
          [
            factory.createPropertyAssignment(
              'title',
              factory.createStringLiteral(
                screenDetails.title || capitalizeFirstLetter(screenDetails.name)
              )
            ),
            factory.createPropertyAssignment(
              'tabBarIconName',
              factory.createStringLiteral(screenDetails.icon || screenDetails.name.toLowerCase())
            ),
          ],
          true
        )
      ), // multiLine for options object
    ],
    true
  ) // multiLine for the screen object itself
}
// --- End AST Helper Functions ---

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
    let commandsToExecute = { add: [], delete: [] }

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
                    const commandType = prop.name.text
                    if (
                      (commandType === 'add' || commandType === 'delete') &&
                      ts.isArrayLiteralExpression(prop.initializer)
                    ) {
                      commandsToExecute[commandType] = []
                      prop.initializer.elements.forEach((elementNode) => {
                        if (ts.isObjectLiteralExpression(elementNode)) {
                          const commandArg = {}
                          elementNode.properties.forEach((cmdProp) => {
                            if (
                              ts.isPropertyAssignment(cmdProp) &&
                              ts.isIdentifier(cmdProp.name) &&
                              cmdProp.initializer
                            ) {
                              const cmdPropName = cmdProp.name.text
                              if (
                                ts.isStringLiteral(cmdProp.initializer) ||
                                (ts.isIdentifier(cmdProp.initializer) && typeof cmdProp.initializer.text === 'string')
                              ) {
                                commandArg[cmdPropName] = cmdProp.initializer.text
                              } else if (cmdProp.initializer.kind === ts.SyntaxKind.TrueKeyword) {
                                commandArg[cmdPropName] = true
                              } else if (cmdProp.initializer.kind === ts.SyntaxKind.FalseKeyword) {
                                commandArg[cmdPropName] = false
                              }
                            }
                          })
                          if (commandArg.name) {
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
          if (ts.isIdentifier(decl.name) && decl.name.text === 'appNavigationStructure') {
            const appNavNode = decl.initializer
            if (appNavNode && ts.isArrayLiteralExpression(appNavNode)) {
              const tabsScreensArrayNode = findTabsScreensArrayNodeFromDeclaration(decl)
              if (tabsScreensArrayNode) {
                parsedScreens.length = 0
                tabsScreensArrayNode.elements.forEach((tabScreenNode) => {
                  if (ts.isObjectLiteralExpression(tabScreenNode)) {
                    const screen = {}
                    tabScreenNode.properties.forEach((prop) => {
                      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                        const propName = prop.name.text
                        const propValueNode = prop.initializer
                        if (propName === 'name' && ts.isStringLiteral(propValueNode))
                          screen.name = propValueNode.text
                        if (propName === 'component' && ts.isIdentifier(propValueNode))
                          screen.componentName = propValueNode.text
                        if (propName === 'options' && ts.isObjectLiteralExpression(propValueNode)) {
                          propValueNode.properties.forEach((optProp) => {
                            if (ts.isPropertyAssignment(optProp) && ts.isIdentifier(optProp.name)) {
                              const optName = optProp.name.text
                              const optValueNode = optProp.initializer
                              if (optName === 'title' && ts.isStringLiteral(optValueNode))
                                screen.title = optValueNode.text
                              if (optName === 'tabBarIconName' && ts.isStringLiteral(optValueNode))
                                screen.icon = optValueNode.text
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

// --- AST Modification Core Function ---
async function modifyLayoutFileWithAst(actions) {
  const fileContent = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
  const sourceFile = ts.createSourceFile(
    NAVIGATION_CONFIG_PATH,
    fileContent,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  )

  const transformResult = ts.transform(sourceFile, [
    (context) => {
      const { factory } = context
      const visit = (node) => {
        // 1. Modify appNavigationStructure
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'appNavigationStructure'
        ) {
          if (node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
            const appNavArrayNode = node.initializer
            const tabsScreensArrayNodeOriginal = findTabsScreensArrayNodeFromDeclaration(node)

            if (tabsScreensArrayNodeOriginal) {
              let currentScreenElements = [...tabsScreensArrayNodeOriginal.elements]

              if (actions.screenNamesToDelete && actions.screenNamesToDelete.length > 0) {
                const namesToDelete = new Set(actions.screenNamesToDelete.map((s) => s.name))
                currentScreenElements = currentScreenElements.filter((elNode) => {
                  if (ts.isObjectLiteralExpression(elNode)) {
                    const nameProp = elNode.properties.find(
                      (p) =>
                        ts.isPropertyAssignment(p) &&
                        ts.isIdentifier(p.name) &&
                        p.name.text === 'name'
                    )
                    if (
                      nameProp &&
                      ts.isPropertyAssignment(nameProp) &&
                      ts.isStringLiteral(nameProp.initializer)
                    ) {
                      return !namesToDelete.has(nameProp.initializer.text)
                    }
                  }
                  return true
                })
              }

              if (actions.screensToAdd && actions.screensToAdd.length > 0) {
                actions.screensToAdd.forEach((screenDetail) => {
                  const exists = currentScreenElements.some((elNode) => {
                    if (ts.isObjectLiteralExpression(elNode)) {
                      const nameProp = elNode.properties.find(
                        (p) =>
                          ts.isPropertyAssignment(p) &&
                          ts.isIdentifier(p.name) &&
                          p.name.text === 'name'
                      )
                      return (
                        nameProp &&
                        ts.isPropertyAssignment(nameProp) &&
                        ts.isStringLiteral(nameProp.initializer) &&
                        nameProp.initializer.text === screenDetail.name
                      )
                    }
                    return false
                  })
                  if (!exists) {
                    currentScreenElements.push(createScreenAstNode(factory, screenDetail))
                  } else {
                    console.log(
                      `AST: Screen '${screenDetail.name}' already present, not adding again.`
                    )
                  }
                })
              }

              const newTabsScreensArray = factory.updateArrayLiteralExpression(
                tabsScreensArrayNodeOriginal,
                currentScreenElements
              )

              const newAppNavInitializer = factory.updateArrayLiteralExpression(
                appNavArrayNode,
                appNavArrayNode.elements.map((rootStackElement) => {
                  if (
                    ts.isObjectLiteralExpression(rootStackElement) &&
                    rootStackElement.properties.some(
                      (p) =>
                        ts.isPropertyAssignment(p) &&
                        ts.isIdentifier(p.name) &&
                        p.name.text === 'name' &&
                        ts.isStringLiteral(p.initializer) &&
                        p.initializer.text === 'Root'
                    )
                  ) {
                    return factory.updateObjectLiteralExpression(
                      rootStackElement,
                      rootStackElement.properties.map((prop) => {
                        if (
                          ts.isPropertyAssignment(prop) &&
                          ts.isIdentifier(prop.name) &&
                          prop.name.text === 'screens'
                        ) {
                          const rootScreensArray = prop.initializer
                          if (ts.isArrayLiteralExpression(rootScreensArray)) {
                            return factory.updatePropertyAssignment(
                              prop,
                              prop.name,
                              factory.updateArrayLiteralExpression(
                                rootScreensArray,
                                rootScreensArray.elements.map((tabNavCandidate) => {
                                  if (
                                    ts.isObjectLiteralExpression(tabNavCandidate) &&
                                    tabNavCandidate.properties.some(
                                      (p) =>
                                        ts.isPropertyAssignment(p) &&
                                        ts.isIdentifier(p.name) &&
                                        p.name.text === 'name' &&
                                        ts.isStringLiteral(p.initializer) &&
                                        p.initializer.text === '(tabs)'
                                    )
                                  ) {
                                    return factory.updateObjectLiteralExpression(
                                      tabNavCandidate,
                                      tabNavCandidate.properties.map((tabNavProp) => {
                                        if (
                                          ts.isPropertyAssignment(tabNavProp) &&
                                          ts.isIdentifier(tabNavProp.name) &&
                                          tabNavProp.name.text === 'screens'
                                        ) {
                                          return factory.updatePropertyAssignment(
                                            tabNavProp,
                                            tabNavProp.name,
                                            newTabsScreensArray
                                          )
                                        }
                                        return tabNavProp
                                      })
                                    )
                                  }
                                  return tabNavCandidate
                                })
                              )
                            )
                          }
                        }
                        return prop
                      })
                    )
                  }
                  return rootStackElement
                })
              )
              return factory.updateVariableDeclaration(
                node,
                node.name,
                node.exclamationToken, // Corrected: Was node.type
                node.type,            // Corrected: Was newAppNavInitializer
                newAppNavInitializer  // Corrected: Added this argument
              )
            }
          }
        }

        if (
          actions.clearCommands &&
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'commandsToExecute'
        ) {
          return factory.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            node.type,
            factory.createObjectLiteralExpression(
              [
                factory.createPropertyAssignment(
                  'add',
                  factory.createArrayLiteralExpression([], true)
                ),
                factory.createPropertyAssignment(
                  'delete',
                  factory.createArrayLiteralExpression([], true)
                ),
              ],
              true
            )
          )
        }
        return ts.visitEachChild(node, visit, context)
      }

      return (sourceFileNode) => {
        let statements = [...sourceFileNode.statements]
        let existingImports = statements.filter(ts.isImportDeclaration)
        const otherStatements = statements.filter((s) => !ts.isImportDeclaration(s))

        if (actions.importsToRemove && actions.importsToRemove.length > 0) {
          const componentsToRemove = new Set(
            actions.importsToRemove.map((imp) => imp.componentName).filter(Boolean)
          )
          if (componentsToRemove.size > 0) {
            existingImports = existingImports.filter((importDecl) => {
              if (
                importDecl.importClause &&
                importDecl.importClause.namedBindings &&
                ts.isNamedImports(importDecl.importClause.namedBindings)
              ) {
                const importedElements = importDecl.importClause.namedBindings.elements
                const hasComponentToRemove = importedElements.some(
                  (el) =>
                    el.name && ts.isIdentifier(el.name) && componentsToRemove.has(el.name.text)
                )

                if (hasComponentToRemove) {
                  const allSpecifiersAreBeingRemoved = importedElements.every(
                    (el) =>
                      el.name && ts.isIdentifier(el.name) && componentsToRemove.has(el.name.text)
                  )
                  if (allSpecifiersAreBeingRemoved) {
                    console.log(
                      `AST: Prepared removal of entire import declaration for: ${importedElements.map((e) => e.name.text).join(', ')}.`
                    )
                    return false
                  }
                  console.log(
                    `AST: Import for a component to remove is part of a multi-import. Kept: ${importDecl.getText(sourceFileNode)}`
                  )
                }
              }
              return true
            })
          }
        }

        if (actions.importsToAdd && actions.importsToAdd.length > 0) {
          actions.importsToAdd.forEach((imp) => {
            if (
              !imp.componentName ||
              !imp.screenName ||
              !/^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(imp.componentName)
            ) {
              console.warn(
                `AST: Invalid or missing componentName ("${imp.componentName}") or screenName ("${imp.screenName}") for import. Skipping import.`
              )
              return
            }
            const relativePath = `../${imp.screenName}/screen`
            const alreadyExists = existingImports.some(
              (i) =>
                i.importClause &&
                i.importClause.namedBindings &&
                ts.isNamedImports(i.importClause.namedBindings) &&
                i.importClause.namedBindings.elements.some(
                  (el) => el.name.text === imp.componentName
                ) &&
                ts.isStringLiteral(i.moduleSpecifier) &&
                i.moduleSpecifier.text === relativePath
            )
            if (!alreadyExists) {
              const newImportSpecifier = factory.createImportSpecifier(
                false,
                undefined,
                factory.createIdentifier(imp.componentName)
              )
              const newNamedImports = factory.createNamedImports([newImportSpecifier])
              const newImportClause = factory.createImportClause(false, undefined, newNamedImports)

              existingImports.push(
                factory.createImportDeclaration(
                  undefined, // decorators
                  undefined, // modifiers
                  newImportClause,
                  factory.createStringLiteral(relativePath),
                  undefined // assertClause
                )
              )
              console.log(`AST: Prepared addition of import for ${imp.componentName} from ${relativePath}.`)
            }
          })
        }

        const transformedOtherStatements = ts.visitNodes(
          factory.createNodeArray(otherStatements),
          visit,
          context // Pass context here
        )
        return factory.updateSourceFile(sourceFileNode, [
          ...existingImports,
          ...transformedOtherStatements,
        ])
      }
    },
  ])

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const newFileContent = printer.printFile(transformResult.transformed[0])

  ignoreNextConfigChange = true
  await fs.writeFile(NAVIGATION_CONFIG_PATH, newFileContent)
  console.log(`layout.tsx AST updated programmatically.`)
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
      actionInProgress = false; // Ensure this is reset
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
      actionInProgress = false; // Ensure this is reset
      return
    }

    let changesEffectivelyMade = false

    // --- Handle Deletions ---
    if (deletedScreens.length > 0) {
      const otherUncommittedChangesDel = await checkUncommittedChanges()
      if (otherUncommittedChangesDel.length > 0) {
        /* Git check */
         console.warn(`Warning: There are ${otherUncommittedChangesDel.length} other uncommitted changes in the repository. Please commit or stash them before proceeding with deletions.`);
        const { confirmDespiteChanges } = await inquirer.default.prompt([
            { type: 'confirm', name: 'confirmDespiteChanges', message: 'Proceed with deletions despite other uncommitted changes?', default: false }
        ]);
        if (!confirmDespiteChanges) {
            console.log('Deletion process cancelled due to uncommitted changes.');
            actionInProgress = false; return;
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
      if (allDeletionOpsConfirmed && (deletedFilePaths.length > 0 || ignoreNextConfigChange)) { // ignoreNextConfigChange might be true if only AST changed
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
          await commitChanges(`feat: remove screens via nav-sync - ${deletedScreens.map(s=>s.name).join(', ')}`, [...deletedFilePaths, NAVIGATION_CONFIG_PATH]);
        }
      } else if (!allDeletionOpsConfirmed) {
        console.log('Deletion process cancelled.')
        actionInProgress = false; return;
      } else {
        console.log('No files actually deleted for deletion batch, but AST might have changed.');
      }
    }

    // --- Handle Renames ---
    if (renamedScreens.length > 0) {
      const otherUncommittedChangesRen = await checkUncommittedChanges()
      if (otherUncommittedChangesRen.length > 0) {
         console.warn(`Warning: There are ${otherUncommittedChangesRen.length} other uncommitted changes. Please commit or stash them.`);
        const { confirmDespiteChanges } = await inquirer.default.prompt([
            { type: 'confirm', name: 'confirmDespiteChanges', message: 'Proceed with renames despite other uncommitted changes?', default: false }
        ]);
        if (!confirmDespiteChanges) {
            console.log('Rename process cancelled.');
            actionInProgress = false; return;
        }
      }

      const renamedOrUpdatedFilePaths = []
      let allRenameOpsConfirmed = true
      for (const { oldScreen, newScreen } of renamedScreens) {
        console.log(`\nProcessing RENAME for '${oldScreen.name}' to '${newScreen.name}'`)
        const renameOps = [
          {
            name: `Rename feature directory for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              const p = await renameFeatureDirectory(oldScreen.name, newScreen.name); if (p) renamedOrUpdatedFilePaths.push(p);
            },
          },
          {
            name: `Rename Expo tab file for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              const p = await renameExpoTabFile(oldScreen.name, newScreen.name); if (p) renamedOrUpdatedFilePaths.push(p);
            },
          },
          {
            name: `Rename Next.js page directory for '${oldScreen.name}' to '${newScreen.name}'`,
            action: async () => {
              const p = await renameNextPageDirectory(oldScreen.name, newScreen.name); if (p) renamedOrUpdatedFilePaths.push(p);
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
           await commitChanges(`feat: rename/update screens via nav-sync - ${renamedScreens.map(r => `${r.oldScreen.name} to ${r.newScreen.name}`).join(', ')}`, [...new Set([...renamedOrUpdatedFilePaths, NAVIGATION_CONFIG_PATH])]);
        }
      } else if (!allRenameOpsConfirmed) {
        console.log('Rename process cancelled.')
        actionInProgress = false; return;
      } else {
        console.log('No files actually renamed/updated for rename batch, but AST might have changed.');
      }
    }

    // --- Handle Updates (title/componentName changes for same screen name) ---
    if (updatedScreens.length > 0) {
      const otherUncommittedChangesUpd = await checkUncommittedChanges()
      if (otherUncommittedChangesUpd.length > 0) {
        /* Git check */
         console.warn(`Warning: There are ${otherUncommittedChangesUpd.length} other uncommitted changes. Please commit or stash them.`);
        const { confirmDespiteChanges } = await inquirer.default.prompt([
            { type: 'confirm', name: 'confirmDespiteChanges', message: 'Proceed with updates despite other uncommitted changes?', default: false }
        ]);
        if (!confirmDespiteChanges) {
            console.log('Update process cancelled.');
            actionInProgress = false; return;
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
           await commitChanges(`feat: update screens via nav-sync - ${updatedScreens.map(s=>s.newScreen.name).join(', ')}`, [...new Set([...updatedFilePaths, NAVIGATION_CONFIG_PATH])]);
        }
      } else if (!allUpdateOpsConfirmed) {
        console.log('Update process cancelled.')
        actionInProgress = false; return;
      } else {
        console.log('No files actually updated for update batch, but AST might have changed.');
      }
    }

    // --- Handle Additions ---
    if (newScreens.length > 0) {
      const otherUncommittedChangesAdd = await checkUncommittedChanges()
      if (otherUncommittedChangesAdd.length > 0) {
        /* Git check */
        console.warn(`Warning: There are ${otherUncommittedChangesAdd.length} other uncommitted changes. Please commit or stash them.`);
        const { confirmDespiteChanges } = await inquirer.default.prompt([
            { type: 'confirm', name: 'confirmDespiteChanges', message: 'Proceed with additions despite other uncommitted changes?', default: false }
        ]);
        if (!confirmDespiteChanges) {
            console.log('Addition process cancelled.');
            actionInProgress = false; return;
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
        // Basic undo: attempt to delete files that were just generated in this failed batch
        if (generatedFilePaths.length > 0) {
            console.log("Attempting to revert generated files due to cancellation...");
            for (const filePath of generatedFilePaths) {
                try {
                    if (await fs.pathExists(filePath)) {
                        await fs.remove(filePath);
                        console.log(`Reverted: Deleted ${filePath}`);
                    }
                } catch (undoError) {
                    console.error(`Error reverting ${filePath}:`, undoError);
                }
            }
        }
        console.log('Addition process cancelled.')
        actionInProgress = false; return;
      }

      if ((generatedFilePaths.length > 0 || ignoreNextConfigChange) && allAdditionOpsConfirmed) { // ensure all ops were confirmed
        console.log('\nFile generation/update process for additions completed!')
        // No need to ask "Do they work as expected?" if all individual steps were confirmed
        const { shouldCommitNew } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'shouldCommitNew',
            message: 'Commit these addition changes?',
            default: true,
          },
        ])
        if (shouldCommitNew) {
          await commitChanges(`feat: add new screens via nav-sync - ${newScreens.map(s=>s.name).join(', ')}`, [...new Set([...generatedFilePaths, NAVIGATION_CONFIG_PATH])]);
        }
        
      } else if (allAdditionOpsConfirmed) { // All ops confirmed but no files generated (e.g. all overwrites skipped by user)
        console.log('\nNo new files were generated for additions (possibly skipped overwrites), but AST might have changed.');
         if (ignoreNextConfigChange) { // If only AST changed
            const { shouldCommitASTOnly } = await inquirer.default.prompt([
                { type: 'confirm', name: 'shouldCommitASTOnly', message: 'Commit layout.tsx changes for additions?', default: true }
            ]);
            if (shouldCommitASTOnly) {
                await commitChanges(`chore: update navigation structure for new screens (no files generated) - ${newScreens.map(s=>s.name).join(', ')}`, [NAVIGATION_CONFIG_PATH]);
            }
        }
      }
    }

    if (changesEffectivelyMade || hasAnyChanges) { // hasAnyChanges ensures even if no files were made but AST was, we update state
      lastAcknowledgedConfigState = { screens: configToProcessScreens } // Use the screens that were *intended* for processing
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
    console.log('Ignoring this config change as it was programmatic.')
    ignoreNextConfigChange = false // Reset for next manual change
    // Update lastAcknowledgedConfigState here if the programmatic change was successful
    // This ensures that the state right after programmatic change is the baseline
    try {
        const updatedConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
        if (updatedConfig && updatedConfig.screens) {
            lastAcknowledgedConfigState = { screens: updatedConfig.screens };
            console.log("Refreshed lastAcknowledgedConfigState after programmatic change.");
        }
    } catch (e) {
        console.error("Error refreshing lastAcknowledgedConfigState after programmatic change:", e);
    }
    return
  }

  console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}. Parsing...`)
  const parsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)

  if (!parsedResult) {
    console.warn('Could not parse navigation config. Waiting for next valid change.')
    editingModeActive = false // Reset editing mode if parsing fails
    return
  }

  let { screens: currentScreensFromFile, isAutoSaveOn, isEditing, commandsToExecute } = parsedResult
  console.log(`Parsed flags from file: isAutoSaveOn=${isAutoSaveOn}, isEditing=${isEditing}`)
  const hasPendingCliCommands =
    commandsToExecute && (commandsToExecute.add?.length > 0 || commandsToExecute.delete?.length > 0)
  if (hasPendingCliCommands) {
    console.log(
      `Parsed commands from file: add: ${commandsToExecute.add?.length || 0}, delete: ${commandsToExecute.delete?.length || 0}`
    )
  }

  // --- Editing Mode Logic ---
  if (isAutoSaveOn) {
    if (isEditing && !hasPendingCliCommands) { // Only enter/stay in editing mode if autosave is on, isEditing is true, AND no commands are pending
      if (!editingModeActive) {
        console.log(
          'Autosave ON and `isEditing` is true (no pending commands). Entering editing mode. Waiting for `isEditing` to become false or commands to be added in layout.tsx to process changes.'
        )
        editingModeActive = true
      } else {
        console.log(
          'Autosave ON and `isEditing` is true (no pending commands). Still in editing mode, waiting for `isEditing` to become false or commands.'
        )
      }
      return // Don't process further if in pure editing mode without commands
    } else { // This block means either isEditing became false, or autosave is on but isEditing is false, or commands are present
      if (editingModeActive && !isEditing) { // Exited editing mode
        console.log('`isEditing` is now false. Processing changes (including any commands).')
        editingModeActive = false
      } else if (!editingModeActive && !isEditing && isAutoSaveOn) { // Autosave on, but was never in editing mode (e.g. initial state or quick toggle)
         console.log('Autosave ON, `isEditing` is false. Processing changes (including any commands).');
      }
      // If hasPendingCliCommands, it will be processed regardless of editingModeActive state.
    }
  } else { // Autosave is OFF
    if (editingModeActive) { // If it was previously in editing mode
      console.log('Autosave turned OFF. Exiting editing mode and processing changes (including any commands).')
      editingModeActive = false
    }
    // If autosave is off and not previously in editing mode, changes are processed directly (including commands).
  }


  // --- Process CommandsToExecute if present ---
  if (hasPendingCliCommands) {
    console.log('Applying commands from `commandsToExecute` in layout.tsx...')
    actionInProgress = true; // Set flag before AST modification

    // Sanitize and prepare commands
    const processedCmdsAdd = (commandsToExecute.add || []).map(cmd => {
      if (!cmd.name || typeof cmd.name !== 'string') {
        console.warn(`AST: Invalid or missing screen name in commandsToExecute.add. Skipping command: ${JSON.stringify(cmd)}`);
        return null;
      }
      const sanitizedName = cmd.name.toLowerCase().replace(/[^a-z0-9_]/gi, '');
      if (!sanitizedName) {
        console.warn(`AST: Invalid screen name "${cmd.name}" (sanitized to empty) in commandsToExecute.add. Skipping this command.`);
        return null;
      }

      let componentName = cmd.componentName;
      if (!componentName || typeof componentName !== 'string' || !/^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(componentName)) {
        if (componentName) {
          console.warn(`AST: Invalid componentName "${componentName}" for screen "${cmd.name}" in commandsToExecute.add. Using default derived from sanitized name "${sanitizedName}".`);
        }
        componentName = capitalizeFirstLetter(sanitizedName) + 'Screen';
      }

      return {
        name: sanitizedName,
        componentName: componentName,
        title: cmd.title || capitalizeFirstLetter(sanitizedName),
        icon: cmd.icon || sanitizedName.toLowerCase(),
      };
    }).filter(cmd => cmd !== null);

    const actionsForAst = {
      screensToAdd: processedCmdsAdd,
      screenNamesToDelete: (commandsToExecute.delete || []).map(cmd => ({ name: cmd.name })), // cmd.name is original here for matching
      importsToAdd: processedCmdsAdd.map(cmd => ({
        componentName: cmd.componentName,
        screenName: cmd.name, // This is the sanitized name
      })),
      importsToRemove: [],
      clearCommands: true,
    };

    const currentParsedForCmds = await parseNavigationConfig(NAVIGATION_CONFIG_PATH); // Re-parse to get latest component names for deletion
    if (currentParsedForCmds && currentParsedForCmds.screens) {
      actionsForAst.importsToRemove = (commandsToExecute.delete || [])
        .map((cmdToDelete) => {
          const screenInLayout = currentParsedForCmds.screens.find((s) => s.name === cmdToDelete.name);
          let componentNameToRemove = cmdToDelete.componentName;
          if (!componentNameToRemove && screenInLayout) {
            componentNameToRemove = screenInLayout.componentName;
          }

          if (componentNameToRemove && /^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(componentNameToRemove)) {
            return { componentName: componentNameToRemove };
          } else if (componentNameToRemove) {
            console.warn(`AST: Invalid or unresolvable componentName for screen deletion command for "${cmdToDelete.name}". Cannot reliably determine import to remove.`);
          }
          return null;
        })
        .filter(imp => imp !== null && imp.componentName);
    }
    
    try {
        await modifyLayoutFileWithAst(actionsForAst);
        // After successful AST modification, re-parse to get the true current state
        const finalParsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
        if (!finalParsedResult || !finalParsedResult.screens) {
          console.error('Failed to re-parse layout.tsx after applying commands. Aborting further processing for this change.');
          actionInProgress = false;
          return;
        }
        currentScreensFromFile = finalParsedResult.screens; // This is the crucial update
        // lastAcknowledgedConfigState should also be updated to this state before processBatchOfChanges
        // so that identifyChanges compares against the state *after* commands were applied by AST.
        lastAcknowledgedConfigState = { screens: currentScreensFromFile };
        console.log("Applied commands and updated lastAcknowledgedConfigState. Proceeding to process file changes.");

    } catch (astError) {
        console.error("Error during AST modification for commandsToExecute:", astError);
        actionInProgress = false;
        return; // Don't proceed if AST modification fails
    } finally {
        // actionInProgress will be reset by processBatchOfChanges or if an error occurs above
    }
  }
   // Reset actionInProgress here if it was set for commands and processBatchOfChanges is not called,
   // or ensure processBatchOfChanges always resets it.
   // Given processBatchOfChanges is called next and has its own actionInProgress logic, this might be okay.

  // --- Process actual file content changes (potentially after commands were applied) ---
  // The `currentScreensFromFile` now reflects the state *after* any `commandsToExecute` have been applied to the AST and file.
  await processBatchOfChanges(currentScreensFromFile);
  // actionInProgress is reset inside processBatchOfChanges
}

// --- Main Execution (CLI command parsing) ---
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  try {
    const initialConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (initialConfig && initialConfig.screens) {
      lastAcknowledgedConfigState = { screens: initialConfig.screens }
      console.log('Initial navigation config (screens part) parsed and stored for CLI session.')
    } else {
      console.error('Failed to parse initial config for CLI session. Please check the file.')
      lastAcknowledgedConfigState = { screens: [] } // Ensure it's initialized
    }
  } catch (err) {
    console.error('Error during initial config parse for CLI session:', err)
    lastAcknowledgedConfigState = { screens: [] } // Ensure it's initialized
  }

  if (command === 'add' || command === 'delete') {
    const screenNames = args.slice(1)
    if (screenNames.length === 0) {
      console.error(`Please provide at least one screen name for the '${command}' command.`)
      process.exit(1)
    }
    // commented out so the file watcher can start add/delete processes after the cli command updates navigation/layout.tsx
    // actionInProgress = true; // Set before potentially long async operations
    await handleDirectCliCommands(command, screenNames);
    // actionInProgress = false; // Reset after command handled
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
      ignoreInitial: true, // Don't run on initial add
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1s for more changes
        pollInterval: 100,
      },
    })

    watcher.on('change', (filePath) => onConfigFileChanged(filePath))
    watcher.on('error', (error) => console.error(`Watcher error: ${error}`))

    // Check initial flags for watcher mode startup
    if (lastAcknowledgedConfigState && lastAcknowledgedConfigState.screens) { // ensure initial parse was somewhat successful
      parseNavigationConfig(NAVIGATION_CONFIG_PATH).then((currentFlagsConfig) => {
        if (currentFlagsConfig) { // Check if parseNavigationConfig returned a result
          console.log(
            `Initial flags for watcher: isAutoSaveOn=${currentFlagsConfig.isAutoSaveOn}, isEditing=${currentFlagsConfig.isEditing}`
          )
          const hasPendingCommands = currentFlagsConfig.commandsToExecute && 
                                     (currentFlagsConfig.commandsToExecute.add?.length > 0 || currentFlagsConfig.commandsToExecute.delete?.length > 0);

          if (currentFlagsConfig.isAutoSaveOn && currentFlagsConfig.isEditing && !hasPendingCommands) {
            editingModeActive = true
            console.log(
              'Started in editing mode due to initial flags in config file (watcher mode, no pending commands).'
            )
          } else if (hasPendingCommands) {
            console.log("Pending commands detected on startup. Triggering initial processing.");
            onConfigFileChanged(NAVIGATION_CONFIG_PATH); // Trigger processing if commands are already there
          } else if (!currentFlagsConfig.isAutoSaveOn || !currentFlagsConfig.isEditing) {
            // If not starting in editing mode, and no commands, potentially trigger a reconcile if state differs.
            // However, current logic processes any detected change on first save.
            // For now, just log.
            console.log("Watcher started. Not in editing mode and no pending commands on startup.");
          }
        }
      }).catch(err => {
        console.error("Error parsing initial flags for watcher mode:", err);
      });
    }
    console.log('CLI tool started in watcher mode. Press Ctrl+C to exit.')
  }
}

async function handleDirectCliCommands(command, screenNames) {
  console.log(`Executing direct CLI command: ${command} for screens: ${screenNames.join(', ')}`)

  try {
    const initialParsed = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (!initialParsed || !initialParsed.screens) {
      console.error('Could not parse initial layout.tsx for CLI command.')
      return
    }

    const actions = {
      screensToAdd: [],
      screenNamesToDelete: [], // Will be array of objects { name: string, componentName?: string }
      importsToAdd: [],
      importsToRemove: [], // Will be array of objects { componentName: string }
      clearCommands: false, // Not clearing commands in direct CLI mode usually
    }

    if (command === 'add') {
      console.log(`Preparing to add screens: ${screenNames.join(', ')} to layout.tsx...`)
      for (const screenNameArg of screenNames) {
        console.log(`\nConfiguring screen to add: ${screenNameArg}`)
        const sanitizedNameBase = screenNameArg.toLowerCase().replace(/[^a-z0-9_]/gi, '')
        if (!sanitizedNameBase) {
          console.warn(`Invalid screen name argument (sanitized to empty): "${screenNameArg}". Skipping.`)
          continue
        }

        let name = sanitizedNameBase
        let componentName = capitalizeFirstLetter(name) + 'Screen'
        let title = capitalizeFirstLetter(name)
        let icon = name.toLowerCase()

        const { confirmDefault } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmDefault',
            message: `Use default config for '${name}' (Component: ${componentName}, Title: ${title})?`,
            default: true,
          },
        ])
        if (!confirmDefault) {
          const answers = await inquirer.default.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Enter screen name (lowercase, valid for paths/identifiers):',
              default: name,
              validate: (input) =>
                /^[a-z0-9_]+$/.test(input)
                  ? true
                  : 'Please use lowercase letters, numbers, and underscores only.',
            },
            {
              type: 'input',
              name: 'componentName',
              message: 'Enter ComponentName (e.g., MyScreenComponent):',
              default: componentName,
              validate: (input) =>
                /^[A-Z][a-zA-Z0-9_]*Screen$/.test(input) // Allow underscore in component name
                  ? true
                  : 'Must be PascalCase ending with Screen (e.g. MyExampleScreen, My_ExampleScreen)',
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

        const existingScreen = initialParsed.screens.find((s) => s.name === name)
        if (!existingScreen) {
          actions.screensToAdd.push({ name, componentName, title, icon })
          actions.importsToAdd.push({ componentName, screenName: name })
        } else {
          console.log(`Screen '${name}' already exists in configuration. Skipping addition.`)
        }
      }
    } else if (command === 'delete') {
      console.log(`Preparing to delete screens: ${screenNames.join(', ')} from layout.tsx...`)
      for (const screenNameToDelete of screenNames) {
        // For CLI delete, screenNameToDelete might need sanitization if we want to be lenient,
        // but typically users specify the exact name from the config.
        // Let's assume screenNameToDelete is the exact name as in the config.
        const screenToDelete = initialParsed.screens.find((s) => s.name === screenNameToDelete)
        if (!screenToDelete) {
          console.warn(
            `Screen '${screenNameToDelete}' not found in current config. Skipping its deletion from AST.`
          )
          continue
        }
        console.log(`\nDetails of screen to delete: ${JSON.stringify(screenToDelete, null, 2)}`)
        const { confirmDelete } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmDelete',
            message: `Confirm removal of screen '${screenNameToDelete}' from layout.tsx?`,
            default: true,
          },
        ])

        if (!confirmDelete) {
          console.log(`Skipped removal of '${screenNameToDelete}' from layout.tsx.`)
          continue
        }
        // Pass the whole screen object for componentName access in AST modification if needed,
        // or just name if AST part only needs name. The current AST delete needs {name: string}.
        actions.screenNamesToDelete.push({ name: screenToDelete.name })
        if (screenToDelete.componentName && /^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(screenToDelete.componentName)) {
            actions.importsToRemove.push({ componentName: screenToDelete.componentName })
        } else if (screenToDelete.componentName) {
            console.warn(`AST: Component name "${screenToDelete.componentName}" for screen "${screenToDelete.name}" is invalid. Import may not be removed correctly.`);
        }
        console.log(`Prepared AST deletion of '${screenNameToDelete}'.`)
      }
    }

    if (actions.screensToAdd.length > 0 || actions.screenNamesToDelete.length > 0) {
      await modifyLayoutFileWithAst(actions) // This will also handle imports
      console.log(`layout.tsx AST updated programmatically for command: ${command}.`)
    } else {
      console.log('No effective changes to make to layout.tsx from CLI command.')
      // If no AST changes, no need to call processBatchOfChanges unless we want to trigger file generation for some reason
      // For now, if no AST changes, we assume no further processing needed for direct CLI.
      return;
    }

    // Re-parse the config to get the state *after* AST modification by CLI command
    // and then process those changes (e.g., generate files for new screens)
    const finalParsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (finalParsedResult && finalParsedResult.screens) {
      // Update lastAcknowledgedConfigState to reflect the state *before* CLI-induced changes were processed by processBatchOfChanges.
      // Or rather, processBatchOfChanges should compare against the state *before* the CLI command *modified* the AST.
      // `initialParsed.screens` is the state before `modifyLayoutFileWithAst`.
      // `finalParsedResult.screens` is the state after `modifyLayoutFileWithAst`.
      // So, `identifyChanges` should compare `finalParsedResult.screens` (new) vs `initialParsed.screens` (old).
      lastAcknowledgedConfigState = { screens: initialParsed.screens }; // Set old state
      await processBatchOfChanges(finalParsedResult.screens); // Pass new state
    } else {
      console.error(
        'Failed to parse config after programmatic update by CLI command. Aborting file processing.'
      )
    }
  } catch (error) {
    console.error(`Error during 'handleDirectCliCommands' for ${command}:`, error)
  }
}

main().catch((err) => {
  console.error('Unhandled error in main execution:', err)
  process.exit(1)
})