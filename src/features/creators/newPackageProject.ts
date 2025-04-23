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
    replaceInFile,
} from './creationHelpers';
import { EXTENSION_ROOT_DIR } from '../../common/constants';
import { EnvironmentManagers } from '../../internal.api';
import { showInputBoxWithButtons } from '../../common/window.apis';

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = 'newPackage';
    public readonly displayName = 'Package';
    public readonly description = 'Create a package folder nested in the current workspace.';
    public readonly tooltip = new MarkdownString('Create a new Python package');

    constructor(private readonly envManagers: EnvironmentManagers) {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // Prompt for package name (TODO: this doesn't make sense if the _options is already being passed in )
        const packageName = await showInputBoxWithButtons({
            prompt: 'What is the name of the package? (e.g. my_package)',
            ignoreFocusOut: true,
            showBackButton: true,
        });
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
        const destRoot = workspaceFolders[0].uri.fsPath; // this doesn't seem right...
        // Check if the destination folder already exists
        const destFolder = path.join(destRoot, `${packageName}_project`);
        if (await fs.pathExists(destFolder)) {
            window.showErrorMessage('A project folder by that name already exists, aborting.');
            return undefined;
        }
        await fs.copy(templateFolder, destFolder);

        // custom instructions
        const instructionsTextPath = path.join(
            EXTENSION_ROOT_DIR,
            'src',
            'features',
            'creators',
            'templates',
            'copilot-instructions-text',
            'package-copilot-instructions.md',
        );
        const instructionsText = `\n \n` + (await fs.readFile(instructionsTextPath, 'utf-8'));

        // check to see if .github folder exists
        const githubFolderPath = path.join(destRoot, '.github');
        const customInstructionsPath = path.join(githubFolderPath, 'copilot-instructions.md');
        const ghFolder = await fs.pathExists(githubFolderPath);
        if (ghFolder) {
            const customInstructions = await fs.pathExists(customInstructionsPath);
            if (customInstructions) {
                // Append to the existing file
                await fs.appendFile(customInstructionsPath, instructionsText);
            } else {
                // Create the file if it doesn't exist
                await fs.writeFile(customInstructionsPath, instructionsText);
            }
        } else {
            // Create the .github folder and the file
            await fs.mkdir(githubFolderPath);
            await fs.writeFile(customInstructionsPath, instructionsText);
        }

        // 2. Replace <package_name> in all files and file/folder names using helper
        await replaceInFilesAndNames(destFolder, 'package_name', packageName);

        // 3. Remove Copilot instructions folder if needed
        if (!createCopilotInstructions) {
            await removeCopilotInstructions(destFolder);
        }

        // 4. Create virtual environment if requested
        if (createVenv) {
            await quickCreateNewVenv(this.envManagers, destFolder);
        }

        // 5. Get the Python environment for the destination folder
        // could be either the one created in step 4 or an existing one
        const pythonEnvironment = await this.envManagers.getEnvironment(Uri.parse(destFolder));

        // 6. Replace <run_exec> and <activation_command> in README.md
        // const readmeFilePath = path.join(destFolder, 'README.md');
        if (!pythonEnvironment) {
            window.showErrorMessage('Python environment not found.');
            return undefined;
        }
        const execInfo = pythonEnvironment.execInfo;
        if (execInfo.run) {
            // const { executable, args = [] } = execInfo.run;
            // const execRunStr = [executable, ...args].join(' ');
            // TODO: check this as I don't think I need this anymore
            await replaceInFile(customInstructionsPath, '<package_name>', packageName);
        }

        // TODO: insert copilot instructions text into the copilot instructions file
        // TODO: insert configs into existing launch.json file

        // Return a PythonProject OR Uri (if no venv was created)
        return {
            name: packageName,
            uri: Uri.file(destFolder),
        };
    }
}
