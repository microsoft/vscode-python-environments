import { window, extensions, Uri } from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { EnvironmentManagers } from '../../internal.api';
import { CreateEnvironmentOptions, EnvironmentManager } from '../../api';
import { traceVerbose } from '../../common/logging';

/**
 * Prompts the user to choose whether to create a new virtual environment (venv) for a package.
 * @returns {Promise<boolean | undefined>} Resolves to true if 'Yes' is selected, false if 'No', or undefined if cancelled.
 */
export async function promptForVenv(): Promise<boolean | undefined> {
    const venvChoice = await window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Would you like to create a new virtual environment for this package?',
        ignoreFocusOut: true,
    });
    if (!venvChoice) {
        return undefined;
    }
    return venvChoice === 'Yes';
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
    const copilotChoice = await window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Would you like to create a Copilot instructions file?',
        ignoreFocusOut: true,
    });
    if (!copilotChoice) {
        return undefined;
    }
    return copilotChoice === 'Yes';
}

/**
 * Removes the .github Copilot instructions folder from the specified destination folder, if it exists.
 * @param destFolder - The absolute path to the destination folder where the .github folder may exist.
 * @returns {Promise<void>} Resolves when the folder is removed or if it does not exist.
 */
export async function removeCopilotInstructions(destFolder: string) {
    const copilotFolder = path.join(destFolder, '.github');
    if (await fs.pathExists(copilotFolder)) {
        await fs.remove(copilotFolder);
    }
}

/**
 * Quickly creates a new Python virtual environment (venv) in the specified destination folder using the available environment managers.
 * Attempts to use the venv manager if available, otherwise falls back to any manager that supports environment creation.
 * @param envManagers - The collection of available environment managers.
 * @param destFolder - The absolute path to the destination folder where the environment should be created.
 * @returns {Promise<void>} Resolves when the environment is created or an error is shown.
 */
export async function quickCreateNewVenv(envManagers: EnvironmentManagers, destFolder: string) {
    try {
        // get the environment manager for venv
        const envManager: EnvironmentManager | undefined = envManagers.managers.find(
            (m) => m.id === 'ms-python.python:venv',
        );
        const destUri = Uri.parse(destFolder);
        if (envManager && envManager.create) {
            // with quickCreate enabled, user will not be prompted when creating the environment
            const options: CreateEnvironmentOptions = { quickCreate: false };
            if (envManager.quickCreateConfig) {
                options.quickCreate = true;
            }
            const pyEnv = await envManager.create(destUri, options);
            // comes back as undefined if this doesn't work
            traceVerbose(`Created venv at: ${pyEnv?.environmentPath} using ${envManager.name}`);
        } else {
            // find an environment manager that supports create
            const envManager = envManagers.managers.find((m) => m.create);
            if (envManager) {
                const options: CreateEnvironmentOptions = { quickCreate: true, additionalPackages: [] };
                const pyEnv = await envManager.create(destUri, options);
                traceVerbose(`Created venv at: ${pyEnv?.environmentPath} using ${envManager.name}`);
            }
            // If no environment manager supports create, show an error message
            window.showErrorMessage(
                `No environment manager found that supports creating a new environment, skipping...`,
            );
        }
    } catch (err) {
        window.showErrorMessage(`Failed to create virtual environment: ${err}`);
    }
}

/**
 * Replaces all occurrences of a string in a single file's contents, safely handling special regex characters in the search value.
 * @param filePath - The absolute path to the file to update.
 * @param searchValue - The string to search for (will be escaped for regex).
 * @param replaceValue - The string to replace with.
 * @returns {Promise<void>} Resolves when the file has been updated.
 */
export async function replaceInFile(filePath: string, searchValue: string, replaceValue: string) {
    // Escape special regex characters in searchValue
    const escapedSearchValue = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedSearchValue, 'g');
    let content = await fs.readFile(filePath, 'utf8');
    if (content.includes(searchValue)) {
        content = content.replace(regex, replaceValue);
        await fs.writeFile(filePath, content, 'utf8');
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
