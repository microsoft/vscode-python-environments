import * as fs from 'fs-extra';
import * as path from 'path';
import { Uri, workspace, MarkdownString, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import {
    promptForVenv,
    promptForCopilotInstructions,
    isCopilotInstalled,
    quickCreateNewVenv,
    replaceInFilesAndNames,
    manageCopilotInstructionsFile,
    manageLaunchJsonFile,
} from './creationHelpers';
import { NEW_PROJECT_TEMPLATES_FOLDER } from '../../common/constants';
import { EnvironmentManagers } from '../../internal.api';
import { showInputBoxWithButtons } from '../../common/window.apis';

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = 'newPackage';
    public readonly displayName = 'Package';
    public readonly description = 'Create a package folder nested in the current workspace.';
    public readonly tooltip = new MarkdownString('Create a new Python package');

    constructor(private readonly envManagers: EnvironmentManagers) {}

    async create(options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // Prompt for package name if not provided
        let packageName = options?.name;
        if (!packageName) {
            packageName = await showInputBoxWithButtons({
                prompt: 'What is the name of the package? (e.g. my_package)',
                ignoreFocusOut: true,
                showBackButton: true,
            });
        }
        if (!packageName) {
            return undefined;
        }

        // Use helper to prompt for virtual environment creation
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
        const newPackageTemplateFolder = path.join(NEW_PROJECT_TEMPLATES_FOLDER, 'newPackageTemplate');
        if (!(await fs.pathExists(newPackageTemplateFolder))) {
            window.showErrorMessage('Template folder does not exist, aborting creation.');
            return undefined;
        }

        // Check if the destination folder is provided, otherwise use the first workspace folder
        let destRoot = options?.uri?.fsPath;
        if (!destRoot) {
            const workspaceFolders = workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                window.showErrorMessage('No workspace folder is open or provided, aborting creation.');
                return undefined;
            }
            destRoot = workspaceFolders[0].uri.fsPath;
        }

        // Check if the destination folder already exists
        const projectDestinationFolder = path.join(destRoot, `${packageName}_project`);
        if (await fs.pathExists(projectDestinationFolder)) {
            window.showErrorMessage(
                'A project folder by that name already exists, aborting creation. Please retry with a unique package name given your workspace.',
            );
            return undefined;
        }
        await fs.copy(newPackageTemplateFolder, projectDestinationFolder);

        // 2. Replace 'package_name' in all files and file/folder names using a helper
        await replaceInFilesAndNames(projectDestinationFolder, 'package_name', packageName);

        // 4. Create virtual environment if requested
        if (createVenv) {
            await quickCreateNewVenv(this.envManagers, projectDestinationFolder);
        }

        // 5. Get the Python environment for the destination folder
        // could be either the one created in an early step or an existing one
        const pythonEnvironment = await this.envManagers.getEnvironment(Uri.parse(projectDestinationFolder));

        if (!pythonEnvironment) {
            window.showErrorMessage('Python environment not found.');
            return undefined;
        }

        // add custom github copilot instructions
        if (createCopilotInstructions) {
            const packageInstructionsPath = path.join(
                NEW_PROJECT_TEMPLATES_FOLDER,
                'copilot-instructions-text',
                'package-copilot-instructions.md',
            );
            await manageCopilotInstructionsFile(destRoot, packageName, packageInstructionsPath);
        }

        // update launch.json file with config for the package
        const launchJsonConfig = {
            name: `Python Package: ${packageName}`,
            type: 'debugpy',
            request: 'launch',
            module: packageName,
        };
        await manageLaunchJsonFile(destRoot, JSON.stringify(launchJsonConfig));

        // Return a PythonProject OR Uri (if no venv was created)
        return {
            name: packageName,
            uri: Uri.file(projectDestinationFolder),
        };
    }
}
