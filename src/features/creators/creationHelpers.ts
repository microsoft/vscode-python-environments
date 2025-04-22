import { window, extensions } from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';

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

export async function quickCreateNewVenv(destFolder: string) {
    const venvPath = path.join(destFolder, '.venv');
    try {
        // Placeholder: replace with your venv creation logic
        // await quickCreateVenv(...)
        window.showInformationMessage(`(Placeholder) Would create venv at: ${venvPath}`);
    } catch (err) {
        window.showErrorMessage(`Failed to create virtual environment: ${err}`);
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
