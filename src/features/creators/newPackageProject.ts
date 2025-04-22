import * as fs from 'fs-extra';
import * as path from 'path';
import { Uri, workspace, MarkdownString, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import {
    promptForVenv,
    promptForCopilotInstructions,
    isCopilotInstalled,
    quickCreateNewVenv,
    removeCopilotInstructions,
    replaceInFilesAndNames,
} from './creationHelpers';
import { EXTENSION_ROOT_DIR } from '../../common/constants';

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = 'newPackage';
    public readonly displayName = 'Package';
    public readonly description = 'Create a new Python package';
    public readonly tooltip = new MarkdownString('Create a new Python package');

    constructor() {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // Prompt for package name
        const packageName = await window.showInputBox({
            prompt: 'What is the name of the package? (e.g. my_package)',
            ignoreFocusOut: true,
        });
        if (!packageName) {
            return undefined;
        }

        // Use helper for venv
        const createVenv = await promptForVenv();
        if (createVenv === undefined) {
            return undefined;
        }

        // Only prompt for Copilot instructions if Copilot is installed
        let createCopilotInstructions = false;
        if (isCopilotInstalled()) {
            const copilotResult = await promptForCopilotInstructions();
            if (copilotResult === undefined) {
                return undefined;
            }
            createCopilotInstructions = copilotResult === true;
        }

        window.showInformationMessage(
            `Creating a new Python project: ${packageName}\nvenv: ${createVenv}\nCopilot instructions: ${createCopilotInstructions}`,
        );

        // 1. Copy template folder
        const templateFolder = path.join(
            EXTENSION_ROOT_DIR,
            'src',
            'features',
            'creators',
            'templates',
            'newPackageTemplate',
        );
        if (!(await fs.pathExists(templateFolder))) {
            window.showErrorMessage('Template folder does not exist.');
            return undefined;
            // might need another check or error handling here
        }
        const workspaceFolders = workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            window.showErrorMessage('No workspace folder is open.');
            return undefined;
        }
        const destRoot = workspaceFolders[0].uri.fsPath;
        const destFolder = path.join(destRoot, `${packageName}_project`);
        await fs.copy(templateFolder, destFolder);

        // 2. Replace <package_name> in all files and file/folder names using helper
        await replaceInFilesAndNames(destFolder, 'package_name', packageName);

        // 3. Remove Copilot instructions folder if needed
        if (!createCopilotInstructions) {
            await removeCopilotInstructions(destFolder);
        }

        // 4. Create virtual environment if requested
        if (createVenv) {
            await quickCreateNewVenv(destFolder);
        }

        // Return a PythonProject object if needed by your API
        return {
            name: packageName,
            uri: Uri.file(destFolder),
        };
    }
}
