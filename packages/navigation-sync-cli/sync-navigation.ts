#!/usr/bin/env node

const chokidar = require('chokidar')
const fs = require('fs-extra')
const path = require('path')
const inquirer = require('inquirer')
const simpleGit = require('simple-git')
const ts = require('typescript')

// Set CWD as MONOREPO ROOT
const cliPackageDir = process.cwd() // Now this is /home/gabeb/Coding/yacpab/packages/navigation-sync-cli
const MONOREPO_ROOT = path.resolve(cliPackageDir, '../..') // Go up two levels
console.log('Deduced Monorepo Root:', MONOREPO_ROOT)
const CWD = MONOREPO_ROOT

// const CWD = process.cwd() // Current Working Directory
// console.log(CWD)
const git = simpleGit({ baseDir: CWD })

const NAVIGATION_CONFIG_PATH = path.join(CWD, 'packages/app/features/navigation/layout.tsx')
const FEATURES_PATH = path.join(CWD, 'packages/app/features')
const EXPO_APP_PATH = path.join(CWD, 'apps/expo/app')
const NEXT_APP_PATH = path.join(CWD, 'apps/next/app')

let isProcessing = false // To prevent concurrent processing
let lastKnownConfigState = null // To store a representation of the last processed config

// --- Helper: Capitalize first letter for component names ---
function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

// --- Placeholder for parsing the navigation config ---
/**
 * Parses the navigation layout file and extracts relevant screen information.
 * @param {string} filePath Path to the layout.tsx file.
 * @returns {object|null} An object representing the navigation structure, or null on error.
 */
async function parseNavigationConfig(filePath) {
  try {
    const fileContent = await fs.readFile(filePath, 'utf-8')
    const sourceFile = ts.createSourceFile(
      path.basename(filePath),
      fileContent,
      ts.ScriptTarget.ESNext,
      true // setParentNodes
    )

    const newScreens = [] // Example: [{ name: 'settings', componentName: 'SettingsScreen', title: 'Settings', icon: 'settings'}]

    // VERY SIMPLIFIED: Look for a specific structure indicating new screens.
    // A robust implementation would traverse the AST deeply.
    function visit(node) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.name.getText(sourceFile) === 'appNavigationStructure') {
            if (decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
              const rootStack = decl.initializer.elements[0] // Assuming first element is root stack
              if (rootStack && ts.isObjectLiteralExpression(rootStack)) {
                const screensProp = rootStack.properties.find(
                  (p) => p.name.getText(sourceFile) === 'screens'
                )
                if (
                  screensProp &&
                  ts.isPropertyAssignment(screensProp) &&
                  ts.isArrayLiteralExpression(screensProp.initializer)
                ) {
                  const tabsNavigatorConfig = screensProp.initializer.elements.find((el) => {
                    if (ts.isObjectLiteralExpression(el)) {
                      const typeProp = el.properties.find(
                        (p) => p.name.getText(sourceFile) === 'type'
                      )
                      return (
                        typeProp &&
                        ts.isPropertyAssignment(typeProp) &&
                        typeProp.initializer.getText(sourceFile) === "'tabs'"
                      )
                    }
                    return false
                  })

                  if (tabsNavigatorConfig && ts.isObjectLiteralExpression(tabsNavigatorConfig)) {
                    const tabScreensProp = tabsNavigatorConfig.properties.find(
                      (p) => p.name.getText(sourceFile) === 'screens'
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
                            if (ts.isPropertyAssignment(prop)) {
                              const propName = prop.name.getText(sourceFile)
                              const propValueNode = prop.initializer
                              let propValue = propValueNode.getText(sourceFile).replace(/'/g, '') // Basic cleanup

                              if (propName === 'name') screen.name = propValue
                              if (propName === 'component') screen.componentName = propValue // e.g., "SettingsScreen"
                              if (
                                propName === 'options' &&
                                ts.isObjectLiteralExpression(propValueNode)
                              ) {
                                propValueNode.properties.forEach((optProp) => {
                                  if (ts.isPropertyAssignment(optProp)) {
                                    const optName = optProp.name.getText(sourceFile)
                                    const optValue = optProp.initializer
                                      .getText(sourceFile)
                                      .replace(/'/g, '')
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
    console.log('Parsed screens:', JSON.stringify(newScreens, null, 2))
    return { screens: newScreens } // Return the identified screens
  } catch (error) {
    console.error('Error parsing navigation config:', error.message)
    // Avoid crashing on temporary syntax errors during autosave
    if (error instanceof SyntaxError) {
      console.warn(
        'Syntax error in navigation config, likely due to autosave. Skipping this change.'
      )
      return null
    }
    throw error // Re-throw other errors
  }
}

// --- Placeholder for identifying changes ---
/**
 * Compares the current config state with the last known state to find new screens.
 * @param {object} currentConfig The currently parsed config.
 * @param {object} previousConfig The previously stored config.
 * @returns {Array} A list of new screen configurations to generate.
 */
function identifyNewScreens(currentConfig, previousConfig) {
  if (!currentConfig || !currentConfig.screens) return []
  if (!previousConfig || !previousConfig.screens) return currentConfig.screens // All are new

  const previousScreenNames = new Set(previousConfig.screens.map((s) => s.name))
  return currentConfig.screens.filter((s) => !previousScreenNames.has(s.name))
}

// --- Git Operations ---
async function checkUncommittedChanges() {
  const status = await git.status()
  // Filter out the navigation config file itself from this initial check
  const otherChanges = status.files.filter(
    (file) => path.join(CWD, file.path) !== NAVIGATION_CONFIG_PATH && file.working_dir !== '?'
  ) // Exclude untracked
  return otherChanges
}

async function commitChanges(message, filesToAdd = []) {
  try {
    if (filesToAdd.length > 0) {
      await git.add(filesToAdd)
    } else {
      await git.add('.') // Add all changes if no specific files provided
    }
    await git.commit(message)
    console.log('Changes committed successfully.')
  } catch (error) {
    console.error('Error committing changes:', error)
  }
}

// --- File Generation ---
async function generateFeatureScreen(screenName, componentName, title) {
  const featurePath = path.join(FEATURES_PATH, screenName)
  const screenFilePath = path.join(featurePath, 'screen.tsx')
  await fs.ensureDir(featurePath)

  const content = `// packages/app/features/${screenName}/screen.tsx
'use client';

import { View, Text, StyleSheet } from 'react-native';
import { useColorScheme } from "react-native"

export function ${componentName}() {
  const colorScheme = useColorScheme()

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <Text style={{ fontSize: 24, marginBottom: 10, color: colorScheme === 'dark' ? 'white' : 'black' }}>
        ${title}
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
  const relativePath = `../${screenName}/screen` // Assuming layout.tsx is in features/navigation
  const importStatement = `import { ${componentName} } from '${relativePath}';\n`

  try {
    let content = await fs.readFile(NAVIGATION_CONFIG_PATH, 'utf-8')
    // Avoid adding duplicate imports
    if (content.includes(importStatement.trim())) {
      console.log(`Import for ${componentName} already exists in ${NAVIGATION_CONFIG_PATH}`)
      return
    }

    // Add import after other imports, or at the top
    // This is a simplified approach; AST modification is more robust
    const importRegex = /(import .* from '.*;\n)|(import .* from ".*;\n)/g
    let lastImportIndex = 0
    let match
    while ((match = importRegex.exec(content)) !== null) {
      lastImportIndex = match.index + match[0].length
    }

    if (lastImportIndex > 0) {
      content = content.slice(0, lastImportIndex) + importStatement + content.slice(lastImportIndex)
    } else {
      // No imports found, add at the beginning (might need adjustment based on file structure)
      content = importStatement + content
    }

    await fs.writeFile(NAVIGATION_CONFIG_PATH, content)
    console.log(`Added import for ${componentName} to ${NAVIGATION_CONFIG_PATH}`)
  } catch (error) {
    console.error(`Error adding import to ${NAVIGATION_CONFIG_PATH}:`, error)
  }
}

// --- Main Processing Logic ---
async function processNavigationChange() {
  if (isProcessing) {
    console.log('Already processing a change, skipping.')
    return
  }
  isProcessing = true
  console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}`)

  try {
    const currentConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH)
    if (!currentConfig) {
      // Parsing failed, likely syntax error
      isProcessing = false
      return
    }

    const newScreens = identifyNewScreens(currentConfig, lastKnownConfigState)

    if (newScreens.length === 0) {
      console.log('No new screens detected based on current logic.')
      lastKnownConfigState = currentConfig // Update state even if no new screens
      isProcessing = false
      return
    }

    console.log(
      `Detected ${newScreens.length} new screen(s):`,
      newScreens.map((s) => s.name).join(', ')
    )

    // 1. Git: Check for other uncommitted changes
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
          console.log('No commit message provided. Aborting.')
          isProcessing = false
          return
        }
      } else {
        console.log(
          'Proceeding without committing other changes. Please be aware of potential conflicts.'
        )
      }
    }

    // 2. User Confirmation to Start
    const { confirmStart } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirmStart',
        message: `The following new screens will be generated: ${newScreens.map((s) => s.name).join(', ')}. Proceed?`,
        default: true,
      },
    ])

    if (!confirmStart) {
      console.log('Operation cancelled by user.')
      isProcessing = false
      return
    }

    const generatedFilePaths = []
    let allConfirmed = true

    for (const screen of newScreens) {
      if (!screen.name || !screen.componentName || !screen.title) {
        console.warn(`Skipping screen due to missing data: ${JSON.stringify(screen)}`)
        continue
      }
      console.log(`\nProcessing new screen: ${screen.name}`)

      // Generate files and collect paths
      const operations = [
        {
          name: `Generate feature screen for ${screen.name}`,
          action: () => generateFeatureScreen(screen.name, screen.componentName, screen.title),
        },
        {
          name: `Generate Expo tab file for ${screen.name}`,
          action: () => generateExpoTabFile(screen.name, screen.componentName),
        },
        {
          name: `Generate Next.js page file for ${screen.name}`,
          action: () => generateNextPageFile(screen.name, screen.componentName),
        },
        {
          name: `Add import for ${screen.componentName} to navigation config`,
          action: () => addImportToNavigationConfig(screen.componentName, screen.name),
        },
      ]

      for (const op of operations) {
        const { confirmOp } = await inquirer.default.prompt([
          { type: 'confirm', name: 'confirmOp', message: `Confirm: ${op.name}?`, default: true },
        ])
        if (!confirmOp) {
          allConfirmed = false
          console.log(`Operation "${op.name}" cancelled.`)
          break
        }
        try {
          const filePath = await op.action() // Action might return a path or nothing
          if (filePath && typeof filePath === 'string') {
            // Only add if it's a file path
            generatedFilePaths.push(filePath)
          }
          // For import, no file path is returned, so it's fine
        } catch (error) {
          console.error(`Error during "${op.name}":`, error)
          allConfirmed = false
          break
        }

        // Diff and confirm (simplified - real diffing is complex)
        // For now, just a simple confirmation
        const { confirmAfterOp } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmAfterOp',
            message: `"${op.name}" completed. Review and confirm to continue. (Undo will abort all changes for this screen).`,
            default: true,
          },
        ])
        if (!confirmAfterOp) {
          allConfirmed = false
          console.log(`User chose to undo after "${op.name}".`)
          break
        }
      }

      if (!allConfirmed) break // If one screen's generation is cancelled, stop all.
    }

    if (!allConfirmed) {
      console.log('One or more operations were cancelled. Undoing generated files (if any)...')
      // Basic undo: delete generated files. More complex undo might involve git reset.
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
      // Also, potentially revert changes to NAVIGATION_CONFIG_PATH if imports were added
      console.log('Aborting further operations.')
      isProcessing = false
      return
    }

    console.log('\nAll files generated successfully for new screens!')

    // 3. Final Confirmation and Commit
    const { confirmAllWork } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirmAllWork',
        message: 'All changes completed. Do they work as expected?',
        default: true,
      },
    ])

    if (confirmAllWork) {
      const { shouldCommitNew } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'shouldCommitNew',
          message: 'Would you like to commit these new files and changes?',
          default: true,
        },
      ])
      if (shouldCommitNew) {
        const { commitMessageNew } = await inquirer.default.prompt([
          {
            type: 'input',
            name: 'commitMessageNew',
            message: 'Enter commit message for new screens:',
          },
        ])
        if (commitMessageNew) {
          // Add the generated files AND the modified navigation config
          const filesToCommit = [...generatedFilePaths, NAVIGATION_CONFIG_PATH]
          await commitChanges(commitMessageNew, filesToCommit.filter(Boolean)) // Filter out undefined/null
        } else {
          console.log('No commit message provided. New files are not committed.')
        }
      }
    } else {
      console.log('User indicated changes might not be working. Please review and commit manually.')
      // You might offer to undo here as well.
    }

    lastKnownConfigState = currentConfig // Update the state after successful processing
    console.log('Job completed.')
  } catch (error) {
    console.error('An error occurred during processing:', error)
  } finally {
    isProcessing = false
  }
}

// --- Watcher Setup ---
console.log(`Watching for changes in ${NAVIGATION_CONFIG_PATH}...`)
const watcher = chokidar.watch(NAVIGATION_CONFIG_PATH, {
  persistent: true,
  ignoreInitial: true, // Don't run on startup
  awaitWriteFinish: {
    // Helps with rapid saves / autosave
    stabilityThreshold: 1000, // Amount of time in milliseconds for a file size to remain stable before emitting an event
    pollInterval: 100, // Interval in milliseconds to poll file size, if native event polling is not available.
  },
})

watcher.on('change', processNavigationChange)
watcher.on('error', (error) => console.error(`Watcher error: ${error}`))

// Initialize lastKnownConfigState on startup
parseNavigationConfig(NAVIGATION_CONFIG_PATH)
  .then((config) => {
    lastKnownConfigState = config
    console.log('Initial navigation config parsed and stored.')
  })
  .catch((err) => console.error('Failed to parse initial config:', err))

console.log('CLI tool started. Press Ctrl+C to exit.')
