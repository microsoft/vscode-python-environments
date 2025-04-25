import * as fs from 'fs-extra';
import * as path from 'path';
import { extensions, QuickInputButtons, Uri, window } from 'vscode';
import { CreateEnvironmentOptions } from '../../api';
import { traceError, traceVerbose } from '../../common/logging';
import { showQuickPickWithButtons } from '../../common/window.apis';
import { EnvironmentManagers, InternalEnvironmentManager } from '../../internal.api';

/**
 * Prompts the user to choose whether to create a new virtual environment (venv) for a project, with a clearer return and early exit.
 * @returns {Promise<boolean | undefined>} Resolves to true if 'Yes' is selected, false if 'No', or undefined if cancelled.
 */
export async function promptForVenv(callback: () => void): Promise<boolean | undefined> {
    try {
        const venvChoice = await showQuickPickWithButtons([{ label: 'Yes' }, { label: 'No' }], {
            placeHolder: 'Would you like to create a new virtual environment for this project?',
            ignoreFocusOut: true,
            showBackButton: true,
        });
        if (!venvChoice) {
            return undefined;
        }
        if (Array.isArray(venvChoice)) {
            // Should not happen for single selection, but handle just in case
            return venvChoice.some((item) => item.label === 'Yes');
        }
        return venvChoice.label === 'Yes';
    } catch (ex) {
        if (ex === QuickInputButtons.Back) {
            callback();
        }
    }
}

/**
 * Checks if the GitHub Copilot extension is installed in the current VS Code environment.
 * @returns {boolean} True if Copilot is installed, false otherwise.
 */
export function isCopilotInstalled(): boolean {
    return !!extensions.getExtension('GitHub.copilot');
}

/**
 * Prompts the user to choose whether to create a Copilot instructions file, only if Copilot is installed.
 * @returns {Promise<boolean | undefined>} Resolves to true if 'Yes' is selected, false if 'No', or undefined if cancelled or Copilot is not installed.
 */
export async function promptForCopilotInstructions(): Promise<boolean | undefined> {
    if (!isCopilotInstalled()) {
        return undefined;
    }
    const copilotChoice = await showQuickPickWithButtons([{ label: 'Yes' }, { label: 'No' }], {
        placeHolder: 'Would you like to create a Copilot instructions file?',
        ignoreFocusOut: true,
        showBackButton: true,
    });
    if (!copilotChoice) {
        return undefined;
    }
    if (Array.isArray(copilotChoice)) {
        // Should not happen for single selection, but handle just in case
        return copilotChoice.some((item) => item.label === 'Yes');
    }
    return copilotChoice.label === 'Yes';
}

/**
 * Quickly creates a new Python virtual environment (venv) in the specified destination folder using the available environment managers.
 * Attempts to use the venv manager if available, otherwise falls back to any manager that supports environment creation.
 * @param envManagers - The collection of available environment managers.
 * @param destFolder - The absolute path to the destination folder where the environment should be created.
 * @returns {Promise<void>} Resolves when the environment is created or an error is shown.
 */
export async function quickCreateNewVenv(envManagers: EnvironmentManagers, destFolder: string) {
    // get the environment manager for venv, should always exist
    const envManager: InternalEnvironmentManager | undefined = envManagers.managers.find(
        (m) => m.id === 'ms-python.python:venv',
    );
    const destinationUri = Uri.parse(destFolder);
    if (envManager?.supportsQuickCreate) {
        // with quickCreate enabled, user will not be prompted when creating the environment
        const options: CreateEnvironmentOptions = { quickCreate: false };
        if (envManager.supportsQuickCreate) {
            options.quickCreate = true;
        }
        const pyEnv = await envManager.create(destinationUri, options);
        // TODO: do I need to update to say this is the env for the file? Like set it?
        if (!pyEnv) {
            // comes back as undefined if this doesn't work
            window.showErrorMessage(`Failed to create virtual environment, please create it manually.`);
        } else {
            traceVerbose(`Created venv at: ${pyEnv?.environmentPath}`);
        }
    } else {
        window.showErrorMessage(`Failed to quick create virtual environment, please create it manually.`);
    }
}

/**
 * Recursively replaces all occurrences of a string in file and folder names, as well as file contents, within a directory tree.
 * @param dir - The root directory to start the replacement from.
 * @param searchValue - The string to search for in names and contents.
 * @param replaceValue - The string to replace with.
 * @returns {Promise<void>} Resolves when all replacements are complete.
 */
export async function replaceInFilesAndNames(dir: string, searchValue: string, replaceValue: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        let entryName = entry.name;
        let fullPath = path.join(dir, entryName);
        let newFullPath = fullPath;
        // If the file or folder name contains searchValue, rename it
        if (entryName.includes(searchValue)) {
            const newName = entryName.replace(new RegExp(searchValue, 'g'), replaceValue);
            newFullPath = path.join(dir, newName);
            await fs.rename(fullPath, newFullPath);
            entryName = newName;
        }
        if (entry.isDirectory()) {
            await replaceInFilesAndNames(newFullPath, searchValue, replaceValue);
        } else {
            let content = await fs.readFile(newFullPath, 'utf8');
            if (content.includes(searchValue)) {
                content = content.replace(new RegExp(searchValue, 'g'), replaceValue);
                await fs.writeFile(newFullPath, content, 'utf8');
            }
        }
    }
}

/**
 * Ensures the .github/copilot-instructions.md file exists at the given root, creating or appending as needed.
 * @param destinationRootPath - The root directory where the .github folder should exist.
 * @param instructionsText - The text to write or append to the copilot-instructions.md file.
 */
export async function manageCopilotInstructionsFile(
    destinationRootPath: string,
    packageName: string,
    instructionsFilePath: string,
) {
    const instructionsText = `\n \n` + (await fs.readFile(instructionsFilePath, 'utf-8'));
    const githubFolderPath = path.join(destinationRootPath, '.github');
    const customInstructionsPath = path.join(githubFolderPath, 'copilot-instructions.md');
    if (!(await fs.pathExists(githubFolderPath))) {
        // make the .github folder if it doesn't exist
        await fs.mkdir(githubFolderPath);
    }
    const customInstructions = await fs.pathExists(customInstructionsPath);
    if (customInstructions) {
        // Append to the existing file
        await fs.appendFile(customInstructionsPath, instructionsText.replace('<package_name>', packageName));
    } else {
        // Create the file if it doesn't exist
        await fs.writeFile(customInstructionsPath, instructionsText.replace('<package_name>', packageName));
    }
}

/**
 * Appends a configuration object to the configurations array in a launch.json file.
 * @param launchJsonPath - The absolute path to the launch.json file.
 * @param projectLaunchConfig - The stringified JSON config to append.
 */
async function appendToJsonConfigs(launchJsonPath: string, projectLaunchConfig: string) {
    let content = await fs.readFile(launchJsonPath, 'utf8');
    const json = JSON.parse(content);
    // If it's a VS Code launch config, append to configurations array
    if (json && Array.isArray(json.configurations)) {
        const configObj = JSON.parse(projectLaunchConfig);
        json.configurations.push(configObj);
        await fs.writeFile(launchJsonPath, JSON.stringify(json, null, 4), 'utf8');
    } else {
        traceError('Failed to add Project Launch Config to launch.json.');
        return;
    }
}

/**
 * Updates the launch.json file in the .vscode folder to include the provided project launch configuration.
 * @param destinationRootPath - The root directory where the .vscode folder should exist.
 * @param projectLaunchConfig - The stringified JSON config to append.
 */
export async function manageLaunchJsonFile(destinationRootPath: string, projectLaunchConfig: string) {
    const vscodeFolderPath = path.join(destinationRootPath, '.vscode');
    const launchJsonPath = path.join(vscodeFolderPath, 'launch.json');
    if (!(await fs.pathExists(vscodeFolderPath))) {
        await fs.mkdir(vscodeFolderPath);
    }
    const launchJsonExists = await fs.pathExists(launchJsonPath);
    if (launchJsonExists) {
        // Try to parse and append to existing launch.json
        await appendToJsonConfigs(launchJsonPath, projectLaunchConfig);
    } else {
        // Create a new launch.json with the provided config
        const launchJson = {
            version: '0.2.0',
            configurations: [JSON.parse(projectLaunchConfig)],
        };
        await fs.writeFile(launchJsonPath, JSON.stringify(launchJson, null, 4), 'utf8');
    }
}
