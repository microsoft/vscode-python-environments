import { window, extensions, Uri } from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { EnvironmentManagers } from '../../internal.api';
import { CreateEnvironmentOptions, EnvironmentManager } from '../../api';
import { traceVerbose } from '../../common/logging';

/**
 * Prompts the user to choose whether to create a new venv for a package.
 * Returns true if the user selects 'Yes', false if 'No', and undefined if cancelled.
 */
export async function promptForVenv(): Promise<boolean | undefined> {
    const venvChoice = await window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Would you like to create a new venv for this package?',
        ignoreFocusOut: true,
    });
    if (!venvChoice) {
        return undefined;
    }
    return venvChoice === 'Yes';
}

/**
 * Returns true if GitHub Copilot extension is installed, false otherwise.
 */
export function isCopilotInstalled(): boolean {
    return !!extensions.getExtension('GitHub.copilot');
}

/**
 * Prompts the user to choose whether to create a Copilot instructions file, only if Copilot is installed.
 * Returns true if the user selects 'Yes', false if 'No', and undefined if cancelled or Copilot not installed.
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

export async function removeCopilotInstructions(destFolder: string) {
    const copilotFolder = path.join(destFolder, '.github');
    if (await fs.pathExists(copilotFolder)) {
        await fs.remove(copilotFolder);
    }
}

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
                const pyEnv = await envManager.create(destUri, {});
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
 * Replaces all occurrences of a string in a single file's contents, handling special regex characters in the search value.
 * @param filePath The path to the file to update.
 * @param searchValue The string to search for (will be escaped for regex).
 * @param replaceValue The string to replace with.
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

// Helper to recursively replace all occurrences of a string in file/folder names and file contents
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
