#!/usr/bin/env node

const chokidar = require('chokidar')
const fs = require('fs-extra')
const path = require('path')
const inquirer = require('inquirer')
const simpleGit = require('simple-git')
const ts = require('typescript')

// Set CWD as MONOREPO ROOT
// const cliPackageDir = process.cwd() // Now this is /home/gabeb/Coding/yacpab/packages/navigation-sync-cli
// const MONOREPO_ROOT = path.resolve(cliPackageDir, '../..') // Go up two levels
// console.log('Deduced Monorepo Root:', MONOREPO_ROOT)
// const CWD = MONOREPO_ROOT

const MONOREPO_ROOT = process.cwd() // Current Working Directory
// console.log(CWD)
const CWD = MONOREPO_ROOT
const git = simpleGit({ baseDir: CWD })

const NAVIGATION_CONFIG_PATH = path.join(CWD, 'packages/app/features/navigation/layout.tsx')
const FEATURES_PATH = path.join(CWD, 'packages/app/features')
const EXPO_APP_PATH = path.join(CWD, 'apps/expo/app')
const NEXT_APP_PATH = path.join(CWD, 'apps/next/app')


let lastAcknowledgedConfigState = null; // Stores the config state that was last acted upon or acknowledged by user
let actionInProgress = false; // Prevents concurrent execution of the main processing block

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
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      path.basename(filePath),
      fileContent,
      ts.ScriptTarget.ESNext,
      true // setParentNodes
    );

    const newScreens = [];
    function visit(node) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.name.getText(sourceFile) === 'appNavigationStructure') {
            if (decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
              const rootStack = decl.initializer.elements[0];
              if (rootStack && ts.isObjectLiteralExpression(rootStack)) {
                const screensProp = rootStack.properties.find(p => p.name?.getText(sourceFile) === 'screens');
                if (screensProp && ts.isPropertyAssignment(screensProp) && ts.isArrayLiteralExpression(screensProp.initializer)) {
                  const tabsNavigatorConfig = screensProp.initializer.elements.find(el => {
                    if (ts.isObjectLiteralExpression(el)) {
                      const typeProp = el.properties.find(p => p.name?.getText(sourceFile) === 'type');
                      const nameProp = el.properties.find(p => p.name?.getText(sourceFile) === 'name');
                      return typeProp && ts.isPropertyAssignment(typeProp) && typeProp.initializer.getText(sourceFile).includes('tabs') &&
                             nameProp && ts.isPropertyAssignment(nameProp) && nameProp.initializer.getText(sourceFile).includes('(tabs)');
                    }
                    return false;
                  });

                  if (tabsNavigatorConfig && ts.isObjectLiteralExpression(tabsNavigatorConfig)) {
                    const tabScreensProp = tabsNavigatorConfig.properties.find(p => p.name?.getText(sourceFile) === 'screens');
                    if (tabScreensProp && ts.isPropertyAssignment(tabScreensProp) && ts.isArrayLiteralExpression(tabScreensProp.initializer)) {
                      tabScreensProp.initializer.elements.forEach(tabScreenNode => {
                        if (ts.isObjectLiteralExpression(tabScreenNode)) {
                          const screen = {};
                          tabScreenNode.properties.forEach(prop => {
                            if (ts.isPropertyAssignment(prop) && prop.name) {
                              const propName = prop.name.getText(sourceFile);
                              const propValueNode = prop.initializer;
                              let propValue = propValueNode.getText(sourceFile).replace(/'|"/g, ""); // Basic cleanup

                              if (propName === 'name') screen.name = propValue;
                              if (propName === 'component') screen.componentName = propValue;
                              if (propName === 'options' && ts.isObjectLiteralExpression(propValueNode)) {
                                propValueNode.properties.forEach(optProp => {
                                  if (ts.isPropertyAssignment(optProp) && optProp.name) {
                                    const optName = optProp.name.getText(sourceFile);
                                    const optValue = optProp.initializer.getText(sourceFile).replace(/'|"/g, "");
                                    if (optName === 'title') screen.title = optValue;
                                    if (optName === 'tabBarIconName') screen.icon = optValue;
                                  }
                                });
                              }
                            }
                          });
                          if (screen.name) newScreens.push(screen);
                        }
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    // console.log('Parsed screens:', JSON.stringify(newScreens, null, 2)); // Keep for debugging
    return { screens: newScreens };

  } catch (error) {
    console.error('Error parsing navigation config:', error.message);
    if (error instanceof SyntaxError || error.message.includes('SyntaxError')) { // Broader check for syntax issues
        console.warn("Syntax error in navigation config, likely due to autosave. Skipping this change.");
        return null;
    }
    // For other errors, you might want to decide if they should halt or be logged.
    // For now, returning null will prevent processing.
    return null;
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
  if (!previousConfig || !previousConfig.screens)
    return currentConfig.screens.filter((s) => s.name && s.componentName) // Ensure essential fields exist

  const previousScreenNames = new Set(previousConfig.screens.map((s) => s.name))
  return currentConfig.screens.filter(
    (s) => s.name && s.componentName && !previousScreenNames.has(s.name)
  )
}

// --- Git Operations ---
async function checkUncommittedChanges() {
  const status = await git.status()
  const otherChanges = status.files.filter(
    (file) =>
      path.join(MONOREPO_ROOT, file.path) !== NAVIGATION_CONFIG_PATH && file.working_dir !== '?'
  )
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
      // Be cautious with 'git add .' - ensure CWD for git is MONOREPO_ROOT
      // await git.add('.'); // Might be too broad if not careful with git's CWD
      console.warn('Commit called with no specific files to add.')
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
async function onConfigFileChanged() {
  if (actionInProgress) {
    console.log('Action already in progress. Change will be processed after current action completes or on next save.');
    return;
  }

  console.log(`Change detected in ${NAVIGATION_CONFIG_PATH}. Parsing...`);
  const currentConfig = await parseNavigationConfig(NAVIGATION_CONFIG_PATH);

  if (!currentConfig) {
    console.warn("Could not parse navigation config or file is invalid. Waiting for next valid change.");
    return;
  }

  const newScreens = identifyNewScreens(currentConfig, lastAcknowledgedConfigState);

  if (newScreens.length === 0) {
    console.log('No new screens detected compared to the last acknowledged state.');
    // Update acknowledged state to the latest parsed valid state, even if no new screens,
    // so that minor refactors in the config don't keep triggering "no new screens".
    lastAcknowledgedConfigState = currentConfig;
    return;
  }

  console.log(`Detected ${newScreens.length} potential new screen(s):`, newScreens.map(s => s.name).join(', '));

  try {
    const { confirmProcessNow } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirmProcessNow',
        message: `The following new screen(s) were detected: ${newScreens.map(s => s.name).join(', ')}. Do you want to proceed with generating files and updates for them now?`,
        default: true,
      },
    ]);

    if (!confirmProcessNow) {
      console.log('User chose not to process changes now. These changes will be re-evaluated on the next file modification.');
      // Update acknowledged state so we don't re-prompt for these exact same new screens immediately
      // if the file is saved again without further textual changes.
      lastAcknowledgedConfigState = currentConfig;
      return;
    }

    // User confirmed to process, now start the action sequence
    actionInProgress = true;

    // 1. Git: Check for other uncommitted changes
    const otherUncommittedChanges = await checkUncommittedChanges();
    if (otherUncommittedChanges.length > 0) {
      console.log('Uncommitted changes found (excluding navigation config):');
      otherUncommittedChanges.forEach(f => console.log(`  - ${f.path} (${f.working_dir})`));
      const { shouldCommitOthers } = await inquirer.default.prompt([
        {
          type: 'confirm',
          name: 'shouldCommitOthers',
          message: 'You have other uncommitted changes. Would you like to commit them first?',
          default: false,
        },
      ]);
      if (shouldCommitOthers) {
        const { commitMessageOthers } = await inquirer.default.prompt([
          { type: 'input', name: 'commitMessageOthers', message: 'Enter commit message for other changes:' },
        ]);
        if (commitMessageOthers) {
          await commitChanges(commitMessageOthers, otherUncommittedChanges.map(f => f.path));
        } else {
          console.log('No commit message provided. Aborting current operation.');
          actionInProgress = false;
          return;
        }
      } else {
        console.log('Proceeding without committing other changes. Please be aware of potential conflicts.');
      }
    }

    console.log(`Proceeding with generation for: ${newScreens.map(s => s.name).join(', ')}.`);
    const generatedFilePaths = [];
    let allOpsForBatchConfirmed = true;

    for (const screen of newScreens) {
      if (!screen.name || !screen.componentName || !screen.title) {
          console.warn(`Skipping screen due to missing data: ${JSON.stringify(screen)}`);
          continue;
      }
      console.log(`\nProcessing new screen: ${screen.name}`);
      // ... (Your existing loop for operations: generateFeatureScreen, generateExpoTabFile, etc.)
      // Ensure each operation awaits inquirer.default.prompt and updates allOpsForBatchConfirmed
      // For brevity, I'm omitting the detailed operations loop here, assuming it's similar to your previous version
      // but now operates on `screen` from the `newScreens` array.
      // Example operation:
      // const { confirmOp } = await inquirer.default.prompt([...]);
      // if (!confirmOp) { allOpsForBatchConfirmed = false; break; }
      // await generateFeatureScreen(screen.name, screen.componentName, screen.title);
      // generatedFilePaths.push(path.join(FEATURES_PATH, screen.name, 'screen.tsx'));
      // ... and so on for other files and confirmation steps ...
      const operations = [
        {
          name: `Generate feature screen for ${screen.name}`,
          action: async () => {
            const p = await generateFeatureScreen(screen.name, screen.componentName, screen.title);
            generatedFilePaths.push(p);
          }
        },
        {
          name: `Generate Expo tab file for ${screen.name}`,
          action: async () => {
            const p = await generateExpoTabFile(screen.name, screen.componentName);
            generatedFilePaths.push(p);
          }
        },
        {
          name: `Generate Next.js page file for ${screen.name}`,
          action: async () => {
            const p = await generateNextPageFile(screen.name, screen.componentName);
            generatedFilePaths.push(p);
          }
        },
        {
          name: `Add import for ${screen.componentName} to navigation config`,
          action: () => addImportToNavigationConfig(screen.componentName, screen.name),
        }
      ];

      for (const op of operations) {
        const { confirmOp } = await inquirer.default.prompt([
          { type: 'confirm', name: 'confirmOp', message: `Confirm: ${op.name}?`, default: true },
        ]);
        if (!confirmOp) {
          allOpsForBatchConfirmed = false;
          console.log(`Operation "${op.name}" cancelled.`);
          break;
        }
        try {
            await op.action();
        } catch (error) {
            console.error(`Error during "${op.name}":`, error);
            allOpsForBatchConfirmed = false;
            break;
        }

        const { confirmAfterOp } = await inquirer.default.prompt([
          {
            type: 'confirm',
            name: 'confirmAfterOp',
            message: `"${op.name}" completed. Review and confirm to continue. (Undo will abort all changes for this batch).`,
            default: true,
          },
        ]);
        if (!confirmAfterOp) {
          allOpsForBatchConfirmed = false;
          console.log(`User chose to undo after "${op.name}".`);
          break;
        }
      } // end operation loop

      if (!allOpsForBatchConfirmed) break; // Break from newScreens loop if any screen's ops are cancelled
    } // end for (const screen of newScreens)


    if (!allOpsForBatchConfirmed) {
      console.log('One or more operations were cancelled for the current batch. Undoing generated files...');
      for (const filePath of generatedFilePaths) {
        try {
          if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
            console.log(`Removed: ${filePath}`);
          }
        } catch (undoError) {
          console.error(`Error undoing ${filePath}:`, undoError);
        }
      }
      // The import added to layout.tsx would need manual revert or more sophisticated undo.
      console.log('Aborting operations for this batch. The changes in layout.tsx are still present and will be re-evaluated on next save.');
      // We do NOT update lastAcknowledgedConfigState, so the same newScreens will be detected next time.
      actionInProgress = false;
      return;
    }

    console.log('\nAll files generated successfully for the new screen(s) in this batch!');

    const { confirmAllWork } = await inquirer.default.prompt([
      { type: 'confirm', name: 'confirmAllWork', message: 'All changes completed for this batch. Do they work as expected?', default: true },
    ]);

    if (confirmAllWork) {
      const { shouldCommitNew } = await inquirer.default.prompt([
        { type: 'confirm', name: 'shouldCommitNew', message: 'Would you like to commit these new files and changes?', default: true },
      ]);
      if (shouldCommitNew) {
        const { commitMessageNew } = await inquirer.default.prompt([
          { type: 'input', name: 'commitMessageNew', message: 'Enter commit message for new screens:' },
        ]);
        if (commitMessageNew) {
          const filesToCommit = [...generatedFilePaths, NAVIGATION_CONFIG_PATH].filter(Boolean);
          await commitChanges(commitMessageNew, filesToCommit);
        } else {
          console.log('No commit message provided. New files are not committed.');
        }
      }
    } else {
      console.log('User indicated changes might not be working. Please review and commit manually. Generated files remain.');
    }

    lastAcknowledgedConfigState = currentConfig; // This batch is done and acknowledged.
    console.log('Processing for the current batch of screens completed.');

  } catch (error) {
    console.error('An error occurred during the main processing sequence:', error);
    // Potentially leave lastAcknowledgedConfigState as is, so it retries on next change.
  } finally {
    actionInProgress = false;
  }
}

// --- Watcher Setup ---
console.log(`Watching for changes in ${NAVIGATION_CONFIG_PATH}...`);
const watcher = chokidar.watch(NAVIGATION_CONFIG_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1500, // Wait 1.5 seconds after the last write to consider the file stable
    pollInterval: 100
  }
});

watcher.on('change', onConfigFileChanged); // Use the new handler name
watcher.on('error', error => console.error(`Watcher error: ${error}`));

// Initialize lastAcknowledgedConfigState on startup
parseNavigationConfig(NAVIGATION_CONFIG_PATH)
  .then(config => {
    if (config) {
      lastAcknowledgedConfigState = config;
      console.log('Initial navigation config parsed and stored.');
    } else {
      console.error("Failed to parse initial config on startup. Please check the file.");
    }
  })
  .catch(err => console.error("Error during initial config parse:", err));

console.log('CLI tool started. Press Ctrl+C to exit.');
