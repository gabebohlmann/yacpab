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
      ),
    ],
    true
  )
}
// --- End AST Helper Functions ---

async function parseNavigationConfig(filePath) {
  try {
    const fileContent = await fs.readFile(filePath, 'utf-8')
    const sourceFile = ts.createSourceFile(
      path.basename(filePath),
      fileContent,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX // Ensure it parses TSX for layout.tsx
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
    return { screens: parsedScreens, isAutoSaveOn, isEditing, commandsToExecute, sourceFile }
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
        currentScreen.title !== previousScreen.title ||
        currentScreen.icon !== previousScreen.icon
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
      await git.add(absoluteFilesToAdd.filter(f => fs.existsSync(f))) // Only add existing files
    } else {
      console.warn('Commit called with no specific files to add.')
    }
    await git.commit(message)
    console.log('Changes committed successfully.')
  } catch (error) {
    console.error('Error committing changes:', error)
  }
}

async function generateFeatureScreen(screenName, componentName, title, isUpdateOrRename = false, autoConfirm = false) {
  const featurePath = path.join(FEATURES_PATH, screenName)
  const screenFilePath = path.join(featurePath, 'screen.tsx')
  const promptAction = isUpdateOrRename ? 'Update/overwrite' : 'Overwrite'

  if (await fs.pathExists(screenFilePath) && !autoConfirm) {
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

import { View, Text } from 'react-native';
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

async function generateExpoTabFile(screenName, componentName, isUpdateOrRename = false, autoConfirm = false) {
  const expoTabDir = path.join(EXPO_APP_PATH, '(tabs)')
  const expoFilePath = path.join(expoTabDir, `${screenName}.tsx`)
  const promptAction = isUpdateOrRename ? 'Update/overwrite' : 'Overwrite'

  if (await fs.pathExists(expoFilePath) && !autoConfirm) {
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

async function generateNextPageFile(screenName, componentName, isUpdateOrRename = false, autoConfirm = false) {
  const nextPageDir = path.join(NEXT_APP_PATH, '(tabs)', screenName)
  const nextFilePath = path.join(nextPageDir, 'page.tsx')
  const promptAction = isUpdateOrRename ? 'Update/overwrite' : 'Overwrite'

  if (await fs.pathExists(nextFilePath) && !autoConfirm) {
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
  } else if ((await fs.pathExists(nextPageDir)) && !isUpdateOrRename && !autoConfirm) {
     // No specific prompt needed here if only dir exists, file will be created.
  }
  await fs.ensureDir(nextPageDir) // ensureDir is fine even if it exists

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
    await fs.move(oldPath, newPath) // Use fs.move for robustness
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
    await fs.move(oldPath, newPath)
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
    await fs.move(oldPath, newPath)
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
                const namesToDelete = new Set(actions.screenNamesToDelete.map((s) => s.name)) // s.name is expected
                currentScreenElements = currentScreenElements.filter((elNode) => {
                  if (ts.isObjectLiteralExpression(elNode)) {
                    const nameProp = elNode.properties.find(
                      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name'
                    )
                    if (nameProp && ts.isPropertyAssignment(nameProp) && ts.isStringLiteral(nameProp.initializer)) {
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
                        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name'
                      )
                      return (
                        nameProp && ts.isPropertyAssignment(nameProp) && ts.isStringLiteral(nameProp.initializer) && nameProp.initializer.text === screenDetail.name
                      )
                    }
                    return false
                  })
                  if (!exists) {
                    currentScreenElements.push(createScreenAstNode(factory, screenDetail))
                  } else {
                    console.log(`AST: Screen '${screenDetail.name}' already present in structure, not adding again.`)
                  }
                })
              }

              const newTabsScreensArray = factory.updateArrayLiteralExpression(tabsScreensArrayNodeOriginal, currentScreenElements)
              const newAppNavInitializer = factory.updateArrayLiteralExpression(
                appNavArrayNode,
                appNavArrayNode.elements.map((rootStackElement) => {
                  if (
                    ts.isObjectLiteralExpression(rootStackElement) &&
                    rootStackElement.properties.some(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name' && ts.isStringLiteral(p.initializer) && p.initializer.text === 'Root')
                  ) {
                    return factory.updateObjectLiteralExpression(
                      rootStackElement,
                      rootStackElement.properties.map((prop) => {
                        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'screens') {
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
                                    tabNavCandidate.properties.some(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name' && ts.isStringLiteral(p.initializer) && p.initializer.text === '(tabs)')
                                  ) {
                                    return factory.updateObjectLiteralExpression(
                                      tabNavCandidate,
                                      tabNavCandidate.properties.map((tabNavProp) => {
                                        if (ts.isPropertyAssignment(tabNavProp) && ts.isIdentifier(tabNavProp.name) && tabNavProp.name.text === 'screens') {
                                          return factory.updatePropertyAssignment(tabNavProp, tabNavProp.name, newTabsScreensArray)
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
              return factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, newAppNavInitializer)
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
            node, node.name, node.exclamationToken, node.type,
            factory.createObjectLiteralExpression(
              [
                factory.createPropertyAssignment('add', factory.createArrayLiteralExpression([], true)),
                factory.createPropertyAssignment('delete', factory.createArrayLiteralExpression([], true)),
              ], true
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
          const componentsToRemove = new Set(actions.importsToRemove.map((imp) => imp.componentName).filter(Boolean))
          if (componentsToRemove.size > 0) {
            const newExistingImports = [];
            for (const importDecl of existingImports) {
              if (importDecl.importClause && importDecl.importClause.namedBindings && ts.isNamedImports(importDecl.importClause.namedBindings)) {
                const originalElements = importDecl.importClause.namedBindings.elements;
                const newElements = originalElements.filter(el => !(el.name && ts.isIdentifier(el.name) && componentsToRemove.has(el.name.text)));

                if (newElements.length === 0) {
                  console.log(`AST: Prepared removal of entire import declaration for: ${originalElements.map(e => e.name.text).join(', ')}.`);
                  // Skip adding this importDecl to newExistingImports
                  continue;
                } else if (newElements.length < originalElements.length) {
                  console.log(`AST: Prepared removal of specific component(s) from import declaration. Kept: ${newElements.map(e => e.name.text).join(', ')}`);
                  const updatedNamedImports = factory.updateNamedImports(importDecl.importClause.namedBindings, newElements);
                  const updatedImportClause = factory.updateImportClause(importDecl.importClause, importDecl.importClause.isTypeOnly, importDecl.importClause.name, updatedNamedImports);
                  newExistingImports.push(factory.updateImportDeclaration(importDecl, importDecl.decorators, importDecl.modifiers, updatedImportClause, importDecl.moduleSpecifier, importDecl.assertClause));
                  continue;
                }
              }
              newExistingImports.push(importDecl);
            }
            existingImports = newExistingImports;
          }
        }


        if (actions.importsToAdd && actions.importsToAdd.length > 0) {
          actions.importsToAdd.forEach((imp) => {
            if (!imp.componentName || !imp.screenName || !/^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(imp.componentName)) {
              console.warn(`AST: Invalid or missing componentName ("${imp.componentName}") or screenName ("${imp.screenName}") for import. Skipping import.`);
              return
            }
            const relativePath = `../${imp.screenName}/screen`
            const alreadyExists = existingImports.some(
              (i) => i.importClause && i.importClause.namedBindings && ts.isNamedImports(i.importClause.namedBindings) &&
                     i.importClause.namedBindings.elements.some((el) => el.name.text === imp.componentName) &&
                     ts.isStringLiteral(i.moduleSpecifier) && i.moduleSpecifier.text === relativePath
            )
            if (!alreadyExists) {
              const newImportSpecifier = factory.createImportSpecifier(false, undefined, factory.createIdentifier(imp.componentName))
              const newNamedImports = factory.createNamedImports([newImportSpecifier])
              const newImportClause = factory.createImportClause(false, undefined, newNamedImports)
              existingImports.push(factory.createImportDeclaration(undefined, undefined, newImportClause, factory.createStringLiteral(relativePath), undefined))
              console.log(`AST: Prepared addition of import for ${imp.componentName} from ${relativePath}.`)
            }
          })
        }

        const transformedOtherStatements = ts.visitNodes(factory.createNodeArray(otherStatements), visit, context)
        return factory.updateSourceFile(sourceFileNode, [...existingImports, ...transformedOtherStatements,])
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
    console.warn('processBatchOfChanges called while actionInProgress was already true. This is unexpected.')
    reevaluateAfterCompletion = true
    return
  }
  actionInProgress = true

  try {
    const { newScreens, deletedScreens, updatedScreens, renamedScreens } = identifyChanges(
      configToProcessScreens,
      lastAcknowledgedConfigState?.screens
    )

    const hasAnyChanges = newScreens.length > 0 || deletedScreens.length > 0 || updatedScreens.length > 0 || renamedScreens.length > 0

    if (!hasAnyChanges) {
      console.log('No actionable screen changes to process relative to last acknowledged state.')
      lastAcknowledgedConfigState = { screens: configToProcessScreens }
      actionInProgress = false; return
    }

    let promptMessage = 'The following changes are detected based on your latest edits:\n'
    if (deletedScreens.length > 0) promptMessage += `  - DELETIONS: ${deletedScreens.map((s) => s.name).join(', ')}\n`
    if (renamedScreens.length > 0) promptMessage += `  - RENAMES: ${renamedScreens.map((r) => `'${r.oldScreen.name}' to '${r.newScreen.name}'`).join(', ')}\n`
    if (updatedScreens.length > 0) promptMessage += `  - UPDATES (title/component/icon): ${updatedScreens.map((u) => u.newScreen.name).join(', ')}\n`
    if (newScreens.length > 0) promptMessage += `  - ADDITIONS: ${newScreens.map((s) => s.name).join(', ')}\n`
    promptMessage += 'Do you want to proceed with these changes now?'

    const { confirmProcessNow } = await inquirer.default.prompt([{ type: 'confirm', name: 'confirmProcessNow', message: promptMessage, default: true },])

    if (!confirmProcessNow) {
      console.log('User chose not to process accumulated changes now. Will re-evaluate on next save or relevant event.')
      actionInProgress = false; return
    }

    let changesEffectivelyMade = false
    const allGeneratedOrModifiedFiles = new Set();

    if (deletedScreens.length > 0) {
      const deletedFilePaths = [];
      for (const screen of deletedScreens) {
        console.log(`\nProcessing DELETION for screen: ${screen.name} (Component: ${screen.componentName})`)
        const { confirmDeleteOps } = await inquirer.default.prompt([{
            type: 'confirm',
            name: 'confirmDeleteOps',
            message: `Confirm deletion of ALL associated files for screen '${screen.name}'?`,
            default: true,
        }]);
        if (confirmDeleteOps) {
            const paths = await Promise.all([
                deleteFeature(screen.name),
                deleteExpoTabFile(screen.name),
                deleteNextPage(screen.name)
            ]);
            paths.filter(p => p).forEach(p => deletedFilePaths.push(p));
            if (paths.some(p => p)) changesEffectivelyMade = true;
        } else {
            console.log(`Skipped file deletions for screen '${screen.name}'.`);
        }
      }
      if (deletedFilePaths.length > 0) {
        deletedFilePaths.forEach(p => allGeneratedOrModifiedFiles.add(p));
        console.log('\nDeletion of files completed for this batch!')
      }
    }

    if (renamedScreens.length > 0) {
        for (const { oldScreen, newScreen } of renamedScreens) {
            console.log(`\nProcessing RENAME for '${oldScreen.name}' to '${newScreen.name}'`);
            const { confirmRenameOps } = await inquirer.default.prompt([{
                type: 'confirm',
                name: 'confirmRenameOps',
                message: `Confirm RENAME and REGENERATION of all associated files for '${oldScreen.name}' to '${newScreen.name}'?`,
                default: true,
            }]);
            if (confirmRenameOps) {
                await renameFeatureDirectory(oldScreen.name, newScreen.name);
                await renameExpoTabFile(oldScreen.name, newScreen.name);
                await renameNextPageDirectory(oldScreen.name, newScreen.name);

                const paths = await Promise.all([
                    generateFeatureScreen(newScreen.name, newScreen.componentName, newScreen.title || newScreen.name, true, true),
                    generateExpoTabFile(newScreen.name, newScreen.componentName, true, true),
                    generateNextPageFile(newScreen.name, newScreen.componentName, true, true)
                ]);
                paths.filter(p => p).forEach(p => allGeneratedOrModifiedFiles.add(p));
                if (paths.some(p => p)) changesEffectivelyMade = true;
            } else {
                console.log(`Skipped file operations for rename of '${oldScreen.name}'.`);
            }
        }
    }
    
    if (updatedScreens.length > 0) {
        for (const { newScreen } of updatedScreens) { 
            console.log(`\nProcessing UPDATE for screen: ${newScreen.name}`);
             const { confirmUpdateOps } = await inquirer.default.prompt([{
                type: 'confirm',
                name: 'confirmUpdateOps',
                message: `Confirm REGENERATION of files for screen '${newScreen.name}' due to content/component update?`,
                default: true,
            }]);
            if (confirmUpdateOps) {
                const paths = await Promise.all([
                    generateFeatureScreen(newScreen.name, newScreen.componentName, newScreen.title || newScreen.name, true, true),
                    generateExpoTabFile(newScreen.name, newScreen.componentName, true, true),
                    generateNextPageFile(newScreen.name, newScreen.componentName, true, true)
                ]);
                paths.filter(p => p).forEach(p => allGeneratedOrModifiedFiles.add(p));
                if (paths.some(p => p)) changesEffectivelyMade = true;
            } else {
                 console.log(`Skipped file regeneration for update of '${newScreen.name}'.`);
            }
        }
    }

    if (newScreens.length > 0) {
        for (const screen of newScreens) {
            console.log(`\nProcessing ADDITION for screen: ${screen.name}`);
            const { confirmAddOps } = await inquirer.default.prompt([{
                type: 'confirm',
                name: 'confirmAddOps',
                message: `Confirm generation of ALL associated files for new screen '${screen.name}'?`,
                default: true,
            }]);
            if (confirmAddOps) {
                const paths = await Promise.all([
                    generateFeatureScreen(screen.name, screen.componentName, screen.title || screen.name, false, true),
                    generateExpoTabFile(screen.name, screen.componentName, false, true),
                    generateNextPageFile(screen.name, screen.componentName, false, true)
                ]);
                paths.filter(p => p).forEach(p => allGeneratedOrModifiedFiles.add(p));
                if (paths.some(p => p)) changesEffectivelyMade = true;
            } else {
                console.log(`Skipped file generation for new screen '${screen.name}'.`);
            }
        }
    }

    if (changesEffectivelyMade || ignoreNextConfigChange) { 
      lastAcknowledgedConfigState = { screens: configToProcessScreens }
      console.log("Snapshot `lastAcknowledgedConfigState` updated.")
      
      const filesToCommit = [NAVIGATION_CONFIG_PATH, ...allGeneratedOrModifiedFiles];
      const uniqueFiles = [...new Set(filesToCommit.filter(Boolean))];

      if (uniqueFiles.length > 0) {
        const { confirmCommit } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmCommit',
            message: `Commit ${uniqueFiles.length} updated/generated/deleted file(s) related to navigation changes?`,
            default: true,
          },
        ])
        if (confirmCommit) {
          await commitChanges(`sync: update navigation structure and associated files`, uniqueFiles);
        }
      }
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

// --- Project Consistency Validation ---
function getLayoutImports(sourceFile) {
  const imports = [];
  if (!sourceFile) return imports; 
  sourceFile.statements.forEach(statement => {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const importPath = moduleSpecifier.text;
        const match = importPath.match(/^(?:\.\.\/){1,3}([a-zA-Z0-9_.-]+)\/screen$/);
        if (match) {
          const screenName = match[match.length-1]; 
          if (statement.importClause && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
            statement.importClause.namedBindings.elements.forEach(element => {
              imports.push({
                componentName: element.name.text,
                screenName: screenName, 
              });
            });
          }
        }
      }
    }
  });
  return imports;
}

async function getExistingFeatureScreens() {
  const features = new Set();
  if (!await fs.pathExists(FEATURES_PATH)) return features;
  try {
    const items = await fs.readdir(FEATURES_PATH);
    for (const item of items) {
      if ((await fs.stat(path.join(FEATURES_PATH, item))).isDirectory()) {
        if (await fs.pathExists(path.join(FEATURES_PATH, item, 'screen.tsx'))) {
          features.add(item);
        }
      }
    }
  } catch (e) { console.error("Error scanning feature screens:", e); }
  return features;
}

async function getExistingExpoTabs() {
  const tabs = new Set();
  const expoTabsDir = path.join(EXPO_APP_PATH, '(tabs)');
  if (!await fs.pathExists(expoTabsDir)) return tabs;
  try {
    const items = await fs.readdir(expoTabsDir);
    for (const item of items) {
      // FIX: Ignore _layout.tsx
      if (item.endsWith('.tsx') && item !== '_layout.tsx') {
        tabs.add(item.replace('.tsx', ''));
      }
    }
  } catch (e) { console.error("Error scanning expo tabs:", e); }
  return tabs;
}

async function getExistingNextPages() {
  const pages = new Set();
  const nextPagesDir = path.join(NEXT_APP_PATH, '(tabs)');
  if (!await fs.pathExists(nextPagesDir)) return pages;
  try {
    const items = await fs.readdir(nextPagesDir);
    for (const item of items) {
      if ((await fs.stat(path.join(nextPagesDir, item))).isDirectory()) {
        if (await fs.pathExists(path.join(nextPagesDir, item, 'page.tsx'))) {
          pages.add(item);
        }
      }
    }
  } catch (e) { console.error("Error scanning next pages:", e); }
  return pages;
}

async function validateProjectConsistency(declaredScreens, layoutSourceFile, isInteractive = true) {
  console.log("🕵️ Running project consistency validation...");
  let fixesAppliedThisRun = false;
  let astModifiedThisRun = false;
  const proposedFixes = []; 

  if (!declaredScreens || !layoutSourceFile) {
    console.error("Validation error: Missing declaredScreens or layoutSourceFile.");
    return { fixesApplied: false, astModified: false };
  }

  const declaredScreenNames = new Set(declaredScreens.map(s => s.name));

  const actualFeatureScreens = await getExistingFeatureScreens();
  const actualExpoTabs = await getExistingExpoTabs();
  const actualNextPages = await getExistingNextPages();
  const actualImports = getLayoutImports(layoutSourceFile); 

  for (const screen of declaredScreens) {
    if (!screen.name || !screen.componentName) {
        console.warn(`Validator: Skipping screen with missing name or componentName: ${JSON.stringify(screen)}`);
        continue;
    }
    if (!actualFeatureScreens.has(screen.name)) {
      proposedFixes.push({
        description: `Screen '${screen.name}': Missing feature file.`,
        action: async () => generateFeatureScreen(screen.name, screen.componentName, screen.title || screen.name, false, true),
        type: 'file', fixType: 'generate_feature'
      });
    }
    if (!actualExpoTabs.has(screen.name)) {
      proposedFixes.push({
        description: `Screen '${screen.name}': Missing Expo tab file.`,
        action: async () => generateExpoTabFile(screen.name, screen.componentName, false, true),
        type: 'file', fixType: 'generate_expo'
      });
    }
    if (!actualNextPages.has(screen.name)) {
      proposedFixes.push({
        description: `Screen '${screen.name}': Missing Next.js page file.`,
        action: async () => generateNextPageFile(screen.name, screen.componentName, false, true),
        type: 'file', fixType: 'generate_next'
      });
    }
    
    const hasCorrectImport = actualImports.some(imp => imp.componentName === screen.componentName && imp.screenName === screen.name);
    if (!hasCorrectImport) {
      proposedFixes.push({
        description: `Screen '${screen.name}': Missing import for component '${screen.componentName}'.`,
        type: 'ast', fixType: 'add_import', screenData: { componentName: screen.componentName, screenName: screen.name }
      });
    }
  }

  actualFeatureScreens.forEach(name => {
    if (!declaredScreenNames.has(name)) {
      proposedFixes.push({
        description: `Orphaned feature: 'packages/app/features/${name}'.`,
        action: async () => deleteFeature(name), type: 'file', fixType: 'delete_feature'
      });
    }
  });
  actualExpoTabs.forEach(name => {
    if (!declaredScreenNames.has(name)) {
      proposedFixes.push({
        description: `Orphaned Expo tab: 'apps/expo/app/(tabs)/${name}.tsx'.`,
        action: async () => deleteExpoTabFile(name), type: 'file', fixType: 'delete_expo'
      });
    }
  });
  actualNextPages.forEach(name => {
    if (!declaredScreenNames.has(name)) {
      proposedFixes.push({
        description: `Orphaned Next.js page: 'apps/next/app/(tabs)/${name}'.`,
        action: async () => deleteNextPage(name), type: 'file', fixType: 'delete_next'
      });
    }
  });

  actualImports.forEach(imp => {
    const isUsedByDeclaredScreen = declaredScreens.some(s => s.componentName === imp.componentName && s.name === imp.screenName);
    if (!isUsedByDeclaredScreen) {
      proposedFixes.push({
        description: `Orphaned import: Component '${imp.componentName}' from '../${imp.screenName}/screen'.`,
        type: 'ast', fixType: 'remove_import', screenData: { componentName: imp.componentName, screenName: imp.screenName }
      });
    }
  });

  if (proposedFixes.length === 0) {
    console.log("✅ Project consistency validation passed. No discrepancies found.");
    return { fixesApplied: false, astModified: false };
  }

  console.warn("\nProject Consistency Discrepancies Found:");
  const choices = proposedFixes.map((fix, index) => ({
      name: `${fix.description} (Action: ${fix.fixType.replace(/_/g, ' ')})`,
      value: index,
      checked: true // Pre-select all fixes
  }));

  if (!isInteractive) {
    console.log("Non-interactive mode. Skipping automatic fixes. Discrepancies listed above.");
    return { fixesApplied: false, astModified: false };
  }

  const { selectedFixIndices } = await inquirer.default.prompt([
    {
      type: 'checkbox',
      name: 'selectedFixIndices',
      message: 'Select fixes to apply:',
      choices: choices,
      pageSize: Math.min(choices.length, 20)
    },
  ]);

  if (!selectedFixIndices || selectedFixIndices.length === 0) {
    console.log("No fixes selected by user.");
    return { fixesApplied: false, astModified: false };
  }

  const astActionsForBatch = { importsToAdd: [], importsToRemove: [], screensToAdd: [], screenNamesToDelete: [], clearCommands: false };

  for (const index of selectedFixIndices) {
    const fix = proposedFixes[index];
    console.log(`Applying: ${fix.description}`);
    if (fix.type === 'file' && fix.action) {
      try {
        await fix.action();
        fixesAppliedThisRun = true;
      } catch (e) { console.error(`Error applying file fix: ${fix.description}`, e); }
    } else if (fix.type === 'ast') {
      if (fix.fixType === 'add_import' && fix.screenData) {
        astActionsForBatch.importsToAdd.push(fix.screenData);
      } else if (fix.fixType === 'remove_import' && fix.screenData) {
        astActionsForBatch.importsToRemove.push(fix.screenData);
      }
    }
  }

  if (astActionsForBatch.importsToAdd.length > 0 || astActionsForBatch.importsToRemove.length > 0) {
    console.log("Applying batched AST modifications for imports...");
    try {
        await modifyLayoutFileWithAst(astActionsForBatch);
        astModifiedThisRun = true;
        fixesAppliedThisRun = true;
    } catch (e) { console.error("Error applying AST fixes:", e); }
  }

  if (fixesAppliedThisRun) {
    console.log("Consistency fixes applied. It's recommended to review changes.");
  } else {
    console.log("No fixes were applied from selection.");
  }
  return { fixesApplied: fixesAppliedThisRun, astModified: astModifiedThisRun };
}
// --- End Project Consistency Validation ---


async function onConfigFileChanged(changedPath) {
  if (actionInProgress) {
    console.log('An operation batch is already in progress. Queuing re-evaluation for after completion...')
    reevaluateAfterCompletion = true
    return
  }

  if (changedPath === NAVIGATION_CONFIG_PATH && ignoreNextConfigChange) {
    console.log('Ignoring this config change as it was programmatic.')
    ignoreNextConfigChange = false
    try {
        const updatedConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
        if (updatedConfig && updatedConfig.screens) {
            lastAcknowledgedConfigState = { screens: updatedConfig.screens };
            console.log("Refreshed lastAcknowledgedConfigState after programmatic change.");
        }
    } catch (e) { console.error("Error refreshing lastAcknowledgedConfigState:", e); }
    return
  }

  console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}. Parsing...`)
  let parsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)

  if (!parsedResult) {
    console.warn('Could not parse navigation config. Waiting for next valid change.')
    editingModeActive = false
    return
  }

  let { screens: currentScreensFromFile, isAutoSaveOn, isEditing, commandsToExecute, sourceFile: currentSourceFile } = parsedResult
  console.log(`Parsed flags from file: isAutoSaveOn=${isAutoSaveOn}, isEditing=${isEditing}`)
  const hasPendingCliCommands = commandsToExecute && (commandsToExecute.add?.length > 0 || commandsToExecute.delete?.length > 0)

  if (isAutoSaveOn) {
    if (isEditing && !hasPendingCliCommands) {
      if (!editingModeActive) {
        console.log('Autosave ON, `isEditing` true (no commands). Entering editing mode.')
        editingModeActive = true
      } else {
        console.log('Still in editing mode (Autosave ON, `isEditing` true, no commands).')
      }
      return
    } else {
      if (editingModeActive && !isEditing) {
        console.log('`isEditing` is now false. Processing changes.')
        editingModeActive = false
      } else if (!editingModeActive && !isEditing && isAutoSaveOn) {
         console.log('Autosave ON, `isEditing` false. Processing changes.');
      }
    }
  } else {
    if (editingModeActive) {
      console.log('Autosave OFF. Exiting editing mode and processing changes.')
      editingModeActive = false
    }
  }

  let astActuallyModifiedByCommands = false;
  if (hasPendingCliCommands) {
    console.log('Applying commands from `commandsToExecute` in layout.tsx...')
    
    const processedCmdsAdd = (commandsToExecute.add || []).map(cmd => {
      if (!cmd.name || typeof cmd.name !== 'string') {
        console.warn(`AST: Invalid cmd name. Skipping: ${JSON.stringify(cmd)}`); return null;
      }
      const sanitizedName = cmd.name.toLowerCase().replace(/[^a-z0-9_]/gi, '');
      if (!sanitizedName) {
        console.warn(`AST: Invalid screen name "${cmd.name}" (empty after sanitize). Skipping.`); return null;
      }
      let componentName = cmd.componentName;
      if (!componentName || typeof componentName !== 'string' || !/^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(componentName)) {
        if (componentName) console.warn(`AST: Invalid componentName "${componentName}". Using default for "${sanitizedName}".`);
        componentName = capitalizeFirstLetter(sanitizedName) + 'Screen';
      }
      return { name: sanitizedName, componentName, title: cmd.title || capitalizeFirstLetter(sanitizedName), icon: cmd.icon || sanitizedName.toLowerCase() };
    }).filter(cmd => cmd !== null);

    const actionsForAst = {
      screensToAdd: processedCmdsAdd,
      screenNamesToDelete: (commandsToExecute.delete || []).map(cmd => ({ name: cmd.name })),
      importsToAdd: processedCmdsAdd.map(cmd => ({ componentName: cmd.componentName, screenName: cmd.name })),
      importsToRemove: [],
      clearCommands: true,
    };

    const currentParsedForCmds = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
    if (currentParsedForCmds && currentParsedForCmds.screens) {
      actionsForAst.importsToRemove = (commandsToExecute.delete || [])
        .map((cmdToDelete) => {
          const screenInLayout = currentParsedForCmds.screens.find((s) => s.name === cmdToDelete.name);
          let cn = cmdToDelete.componentName || (screenInLayout ? screenInLayout.componentName : null);
          if (cn && /^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(cn)) return { componentName: cn };
          if (cn) console.warn(`AST: Invalid componentName "${cn}" for delete cmd "${cmdToDelete.name}".`);
          return null;
        }).filter(Boolean);
    }
    
    if (actionsForAst.screensToAdd.length > 0 || actionsForAst.screenNamesToDelete.length > 0 || actionsForAst.importsToAdd.length > 0 || actionsForAst.importsToRemove.length > 0) {
        await modifyLayoutFileWithAst(actionsForAst);
        astActuallyModifiedByCommands = true;
        parsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH); // Re-assign
        if (!parsedResult || !parsedResult.screens) {
          console.error('Failed to re-parse layout.tsx after applying commands. Aborting further processing.');
          return;
        }
        currentScreensFromFile = parsedResult.screens;
        currentSourceFile = parsedResult.sourceFile; 
        lastAcknowledgedConfigState = { screens: currentScreensFromFile };
        console.log("Applied commands from layout.tsx and updated internal state.");
    } else if (actionsForAst.clearCommands && (commandsToExecute.add?.length > 0 || commandsToExecute.delete?.length > 0)) {
        console.log("Clearing empty or ineffective commandsToExecute from layout.tsx.");
        await modifyLayoutFileWithAst({ clearCommands: true });
        astActuallyModifiedByCommands = true;
         parsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH); 
        if (parsedResult) { 
             currentScreensFromFile = parsedResult.screens;
             currentSourceFile = parsedResult.sourceFile;
             lastAcknowledgedConfigState = { screens: currentScreensFromFile };
        }
    } else {
        console.log("No effective AST changes from commandsToExecute.");
    }
  }

  await processBatchOfChanges(currentScreensFromFile);

  if (!actionInProgress) { 
    console.log("Running post-change consistency validation...");
    const latestConfigForValidation = (astActuallyModifiedByCommands || (changedPath === NAVIGATION_CONFIG_PATH && !ignoreNextConfigChange))
                                      ? await parseNavigationConfig(NAVIGATION_CONFIG_PATH) 
                                      : parsedResult; 

    if (latestConfigForValidation && latestConfigForValidation.screens && latestConfigForValidation.sourceFile) {
        const validationResult = await validateProjectConsistency(latestConfigForValidation.screens, latestConfigForValidation.sourceFile);
        if (validationResult.astModified) {
            const finalConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
            if (finalConfig && finalConfig.screens) {
                lastAcknowledgedConfigState = { screens: finalConfig.screens };
            }
        } else if (validationResult.fixesApplied) { 
             const finalConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
            if (finalConfig && finalConfig.screens) {
                lastAcknowledgedConfigState = { screens: finalConfig.screens };
            }
        }
    } else {
        console.warn("Could not get latest config for post-change validation. Parsed result:", latestConfigForValidation);
    }
  }
}

// --- Main Execution (CLI command parsing) ---
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  let initialConfigResult;
  try {
    initialConfigResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
    if (initialConfigResult && initialConfigResult.screens && initialConfigResult.sourceFile) {
      lastAcknowledgedConfigState = { screens: initialConfigResult.screens };
      console.log('Initial navigation config (screens part) parsed and stored.');

      console.log('Performing initial project consistency validation...');
      const validationResult = await validateProjectConsistency(initialConfigResult.screens, initialConfigResult.sourceFile);
      if (validationResult.astModified || validationResult.fixesApplied) { 
        console.log("Consistency fixes applied during startup. Re-parsing config...");
        const updatedConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
        if (updatedConfig && updatedConfig.screens) {
          lastAcknowledgedConfigState = { screens: updatedConfig.screens };
          initialConfigResult = updatedConfig; 
        } else {
          console.error("Failed to re-parse config after initial validation fixes.");
        }
      }
    } else {
      console.error('Failed to parse initial config or sourceFile for CLI session. Please check the file.')
      lastAcknowledgedConfigState = { screens: [] }
    }
  } catch (err) {
    console.error('Error during initial config parse for CLI session:', err)
    lastAcknowledgedConfigState = { screens: [] }
  }

  if (command === 'add' || command === 'delete') {
    const screenNames = args.slice(1)
    if (screenNames.length === 0) {
      console.error(`Please provide at least one screen name for the '${command}' command.`)
      process.exit(1)
    }
    await handleDirectCliCommands(command, screenNames);
    
    const postCliConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
    if (postCliConfig && postCliConfig.screens && postCliConfig.sourceFile) {
        console.log("Running post-CLI command consistency validation...");
        const validationResult = await validateProjectConsistency(postCliConfig.screens, postCliConfig.sourceFile);
        if (validationResult.astModified || validationResult.fixesApplied) {
             const finalConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);
             if (finalConfig && finalConfig.screens) {
                lastAcknowledgedConfigState = { screens: finalConfig.screens };
            }
        }
    } else {
        console.warn("Could not get latest config for post-CLI validation.");
    }

  } else if (command) {
    console.log(`Unknown command: ${command}. Available commands: add, delete. Or run without commands for watcher mode.`)
    process.exit(1)
  } else {
    // --- Watcher Setup (Default mode) ---
    console.log(`Watching for changes in ${NAVIGATION_CONFIG_PATH}...`)
    const watcher = chokidar.watch(NAVIGATION_CONFIG_PATH, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    })

    watcher.on('change', (filePath) => onConfigFileChanged(filePath))
    watcher.on('error', (error) => console.error(`Watcher error: ${error}`))

    if (initialConfigResult) { 
        console.log(`Initial flags for watcher: isAutoSaveOn=${initialConfigResult.isAutoSaveOn}, isEditing=${initialConfigResult.isEditing}`)
        const hasPendingCommands = initialConfigResult.commandsToExecute && 
                                   (initialConfigResult.commandsToExecute.add?.length > 0 || initialConfigResult.commandsToExecute.delete?.length > 0);

        if (initialConfigResult.isAutoSaveOn && initialConfigResult.isEditing && !hasPendingCommands) {
          editingModeActive = true
          console.log('Started in editing mode (watcher mode, no pending commands).')
        } else if (hasPendingCommands) {
          console.log("Pending commands detected on startup. Triggering initial processing for watcher.");
          onConfigFileChanged(NAVIGATION_CONFIG_PATH);
        } else {
          console.log("Watcher started. Not in editing mode and no pending commands on startup.");
        }
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

    const actions = { screensToAdd: [], screenNamesToDelete: [], importsToAdd: [], importsToRemove: [], clearCommands: false, }
    let astChangedByCli = false;

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

        const { confirmDefault } = await inquirer.default.prompt([{ type: 'confirm', name: 'confirmDefault', message: `Use default config for '${name}' (Component: ${componentName}, Title: ${title})?`, default: true,},])
        if (!confirmDefault) {
          const answers = await inquirer.default.prompt([
            { type: 'input', name: 'name', message: 'Screen name (lowercase, path-safe):', default: name, validate: (input) => /^[a-z0-9_]+$/.test(input) ? true : 'Lowercase letters, numbers, underscores only.', },
            { type: 'input', name: 'componentName', message: 'ComponentName (PascalCase, e.g. MyScreen):', default: componentName, validate: (input) => /^[A-Z][a-zA-Z0-9_]*Screen$/.test(input) ? true : 'PascalCase ending with Screen.', },
            { type: 'input', name: 'title', message: 'Screen title (header/tab label):', default: title, },
            { type: 'input', name: 'icon', message: 'tabBarIconName (e.g., home):', default: icon, },
          ])
          name = answers.name; componentName = answers.componentName; title = answers.title; icon = answers.icon
        }
        const existingScreen = initialParsed.screens.find((s) => s.name === name)
        if (!existingScreen) {
          actions.screensToAdd.push({ name, componentName, title, icon })
          actions.importsToAdd.push({ componentName, screenName: name })
          astChangedByCli = true;
        } else {
          console.log(`Screen '${name}' already in config. Skipping AST add.`)
        }
      }
    } else if (command === 'delete') {
      console.log(`Preparing to delete screens: ${screenNames.join(', ')} from layout.tsx...`)
      for (const screenNameToDelete of screenNames) {
        const screenToDelete = initialParsed.screens.find((s) => s.name === screenNameToDelete)
        if (!screenToDelete) {
          console.warn(`Screen '${screenNameToDelete}' not in config. Skipping AST delete.`)
          continue
        }
        console.log(`\nDetails of screen to delete: ${JSON.stringify(screenToDelete, null, 2)}`)
        const { confirmDelete } = await inquirer.default.prompt([{type: 'confirm',name: 'confirmDelete',message: `Confirm removal of screen '${screenNameToDelete}' from layout.tsx?`,default: true,},])
        if (!confirmDelete) {
          console.log(`Skipped AST removal of '${screenNameToDelete}'.`)
          continue
        }
        actions.screenNamesToDelete.push({ name: screenToDelete.name })
        if (screenToDelete.componentName && /^[a-zA-Z_$][a-zA-Z\d_$]*$/.test(screenToDelete.componentName)) {
            actions.importsToRemove.push({ componentName: screenToDelete.componentName })
        } else if (screenToDelete.componentName) {
            console.warn(`AST: Component name "${screenToDelete.componentName}" for screen "${screenToDelete.name}" is invalid. Import may not be removed correctly.`);
        }
        astChangedByCli = true;
        console.log(`Prepared AST deletion of '${screenNameToDelete}'.`)
      }
    }

    if (astChangedByCli) {
      await modifyLayoutFileWithAst(actions)
      console.log(`layout.tsx AST updated programmatically by CLI command: ${command}.`)
    } else {
      console.log('No AST changes made by CLI command.')
    }

    const finalParsedResult = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (finalParsedResult && finalParsedResult.screens) {
      lastAcknowledgedConfigState = { screens: initialParsed.screens }; 
      await processBatchOfChanges(finalParsedResult.screens);
    } else {
      console.error('Failed to parse config after CLI command. Aborting file processing.')
    }
  } catch (error) {
    console.error(`Error during 'handleDirectCliCommands' for ${command}:`, error)
  }
}

main().catch((err) => {
  console.error('Unhandled error in main execution:', err)
  process.exit(1)
})