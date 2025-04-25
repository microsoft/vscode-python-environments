import * as fs from 'fs-extra';
import * as path from 'path';
import { commands, l10n, MarkdownString, QuickInputButtons, Uri, window, workspace } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { NEW_PROJECT_TEMPLATES_FOLDER } from '../../common/constants';
import { showInputBoxWithButtons } from '../../common/window.apis';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import {
    isCopilotInstalled,
    manageCopilotInstructionsFile,
    manageLaunchJsonFile,
    promptForVenv,
    quickCreateNewVenv,
    replaceInFilesAndNames,
} from './creationHelpers';

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = l10n.t('newPackage');
    public readonly displayName = l10n.t('Package');
    public readonly description = l10n.t('Creates a package folder in your current workspace');
    public readonly tooltip = new MarkdownString(l10n.t('Create a new Python package'));

    constructor(
        private readonly envManagers: EnvironmentManagers,
        private readonly projectManager: PythonProjectManager,
    ) {}

    async create(options?: PythonProjectCreatorOptions): Promise<PythonProject | Uri | undefined> {
        let packageName = options?.name;
        let createVenv: boolean | undefined;
        let createCopilotInstructions: boolean | undefined;
        if (options?.quickCreate === true) {
            // If quickCreate is true, we should not prompt for any input
            if (!packageName) {
                throw new Error('Package name is required in quickCreate mode.');
            }
            createVenv = true;
            createCopilotInstructions = true;
        } else {
            //Prompt as quickCreate is false
            if (!packageName) {
                try {
                    packageName = await showInputBoxWithButtons({
                        prompt: l10n.t('What is the name of the package? (e.g. my_package)'),
                        ignoreFocusOut: true,
                        showBackButton: true,
                        validateInput: (value) => {
                            // following PyPI (PEP 508) rules for package names
                            if (!/^([a-z_]|[a-z0-9_][a-z0-9._-]*[a-z0-9_])$/i.test(value)) {
                                return l10n.t(
                                    'Invalid package name. Use only letters, numbers, underscores, hyphens, or periods. Must start and end with a letter or number.',
                                );
                            }
                            if (/^[-._0-9]$/i.test(value)) {
                                return l10n.t('Single-character package names cannot be a number, hyphen, or period.');
                            }
                            return null;
                        },
                    });
                } catch (ex) {
                    if (ex === QuickInputButtons.Back) {
                        await commands.executeCommand('python-envs.createNewProjectFromTemplate');
                    }
                }
                if (!packageName) {
                    return undefined;
                }
                // Use helper to prompt for virtual environment creation
                const callback = () => {
                    return this.create(options);
                };
                createVenv = await promptForVenv(callback);
                if (createVenv === undefined) {
                    return undefined;
                }
                if (isCopilotInstalled()) {
                    createCopilotInstructions = true;
                }
            }

            // 1. Copy template folder
            const newPackageTemplateFolder = path.join(NEW_PROJECT_TEMPLATES_FOLDER, 'newPackageTemplate');
            if (!(await fs.pathExists(newPackageTemplateFolder))) {
                window.showErrorMessage(l10n.t('Template folder does not exist, aborting creation.'));
                return undefined;
            }

            // Check if the destination folder is provided, otherwise use the first workspace folder
            let destRoot = options?.rootUri.fsPath;
            if (!destRoot) {
                const workspaceFolders = workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    window.showErrorMessage(l10n.t('No workspace folder is open or provided, aborting creation.'));
                    return undefined;
                }
                destRoot = workspaceFolders[0].uri.fsPath;
            }

            // Check if the destination folder already exists
            const projectDestinationFolder = path.join(destRoot, `${packageName}_project`);
            if (await fs.pathExists(projectDestinationFolder)) {
                window.showErrorMessage(
                    l10n.t(
                        'A project folder by that name already exists, aborting creation. Please retry with a unique package name given your workspace.',
                    ),
                );
                return undefined;
            }
            await fs.copy(newPackageTemplateFolder, projectDestinationFolder);

            // 2. Replace 'package_name' in all files and file/folder names using a helper
            await replaceInFilesAndNames(projectDestinationFolder, 'package_name', packageName);

            // 4. Create virtual environment if requested
            let createdPackage: PythonProject | undefined;
            if (createVenv) {
                createdPackage = {
                    name: packageName,
                    uri: Uri.file(projectDestinationFolder),
                };

                // add package to list of packages before creating the venv
                this.projectManager.add(createdPackage);
                await quickCreateNewVenv(this.envManagers, projectDestinationFolder);
            }

            // 5. Get the Python environment for the destination folder
            // could be either the one created in an early step or an existing one
            const pythonEnvironment = await this.envManagers.getEnvironment(Uri.parse(projectDestinationFolder));

            if (!pythonEnvironment) {
                window.showErrorMessage(l10n.t('Python environment not found.'));
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

            if (createdPackage) {
                // return package if created (ie when venv is created)
                return createdPackage;
            } else {
                // otherwise its not a package and just a folder
                return Uri.file(projectDestinationFolder);
            }
        }
    }
}
