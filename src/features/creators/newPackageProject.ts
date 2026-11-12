import * as fs from 'fs-extra';
import * as path from 'path';
import { l10n, MarkdownString, QuickInputButtons, Uri } from 'vscode';
import { PythonEnvironment, PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { executeCommand } from '../../common/command.api';
import { NEW_PROJECT_TEMPLATES_FOLDER, VENV_MANAGER_ID } from '../../common/constants';
import { traceError } from '../../common/logging';
import { pickEnvironment } from '../../common/pickers/environments';
import { normalizePath } from '../../common/utils/pathUtils';
import { showErrorMessage, showInputBoxWithButtons } from '../../common/window.apis';
import { getWorkspaceFolders } from '../../common/workspace.apis';
import type { InternalEnvironmentManager } from '../../managers/common/registeredManagers';
import type { EnvironmentManagers } from '../envManagers';
import type { PythonProjectManager } from '../projectManager';
import { removePythonProjectSetting } from '../settings/settingHelpers';
import {
    isCopilotInstalled,
    manageCopilotInstructionsFile,
    manageLaunchJsonFile,
    promptForVenv,
    replaceInFilesAndNames,
} from './creationHelpers';

function showProjectAlreadyExistsError(): void {
    showErrorMessage(
        l10n.t(
            'A project folder by that name already exists, aborting creation. Please retry with a unique package name given your workspace.',
        ),
    );
}

function showProjectAlreadyConfiguredError(): void {
    showErrorMessage(
        l10n.t(
            'A Python project by that name is already configured, aborting creation. Remove it or retry with a unique package name.',
        ),
    );
}

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = l10n.t('newPackage');
    public readonly displayName = l10n.t('Package');
    public readonly description = l10n.t('Creates a package folder in your current workspace');
    public readonly tooltip = new MarkdownString(l10n.t('Create a new Python package'));

    constructor(
        private readonly envManagers: EnvironmentManagers,
        private readonly projectManager: PythonProjectManager,
    ) {}

    private getExactProject(uri: Uri): PythonProject | undefined {
        const project = this.projectManager.get(uri);
        return project && normalizePath(project.uri.fsPath) === normalizePath(uri.fsPath) ? project : undefined;
    }

    private async rollbackCreatedPackage(
        createdPackage: PythonProject,
        projectDestinationFolder: string,
        options: {
            projectFolderOwned: boolean;
            projectRegistrationOwned: boolean;
            environmentManager?: InternalEnvironmentManager;
        },
    ): Promise<void> {
        if (options.environmentManager) {
            const scopeManager = this.envManagers.getEnvironmentManager(createdPackage.uri);
            let selectedManagerCleared = false;
            try {
                await this.envManagers.setEnvironment(createdPackage.uri, undefined, false);
                selectedManagerCleared = scopeManager?.id === options.environmentManager.id;
            } catch (rollbackError) {
                traceError('Failed to clear the new package environment after creation failed:', rollbackError);
            }
            if (!selectedManagerCleared) {
                try {
                    await options.environmentManager.set(createdPackage.uri, undefined);
                } catch (rollbackError) {
                    traceError(
                        'Failed to clear the selected environment manager after package creation failed:',
                        rollbackError,
                    );
                }
            }
        }
        if (options.projectRegistrationOwned) {
            try {
                await removePythonProjectSetting([{ project: createdPackage }]);
            } catch (rollbackError) {
                traceError('Failed to remove the new package setting after creation failed:', rollbackError);
            }
            try {
                this.projectManager.remove(createdPackage);
            } catch (rollbackError) {
                traceError('Failed to remove the new package project after creation failed:', rollbackError);
            }
        }
        if (options.projectFolderOwned) {
            try {
                await fs.remove(projectDestinationFolder);
            } catch (rollbackError) {
                traceError('Failed to delete the new package after creation failed:', rollbackError);
            }
        }
    }

    async create(options?: PythonProjectCreatorOptions): Promise<PythonProject | Uri | undefined> {
        let packageName = options?.name;
        let createVenv: boolean | undefined;
        let createCopilotInstructions: boolean | undefined;
        let selectedEnvironment: PythonEnvironment | undefined;
        const restartCreation = () => {
            void this.create(options);
        };
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
                        await executeCommand('python-envs.createNewProjectFromTemplate');
                    }
                }
                if (!packageName) {
                    return undefined;
                }
                // Use helper to prompt for virtual environment creation
                createVenv = await promptForVenv(restartCreation);
                if (createVenv === undefined) {
                    return undefined;
                }
                if (isCopilotInstalled()) {
                    createCopilotInstructions = true;
                }
            }
        }

        if (!packageName) {
            return undefined;
        }

        // 1. Copy template folder
        const newPackageTemplateFolder = path.join(NEW_PROJECT_TEMPLATES_FOLDER, 'newPackageTemplate');
        if (!(await fs.pathExists(newPackageTemplateFolder))) {
            showErrorMessage(l10n.t('Template folder does not exist, aborting creation.'));
            return undefined;
        }

        // Check if the destination folder is provided, otherwise use the first workspace folder
        let destRoot = options?.rootUri.fsPath;
        if (!destRoot) {
            const workspaceFolders = getWorkspaceFolders();
            if (!workspaceFolders || workspaceFolders.length === 0) {
                showErrorMessage(l10n.t('No workspace folder is open or provided, aborting creation.'));
                traceError(`Template file not found at: ${newPackageTemplateFolder}`);
                return undefined;
            }
            destRoot = workspaceFolders[0].uri.fsPath;
        }

        // Check if the destination folder already exists
        const projectDestinationFolder = path.join(destRoot, `${packageName}_project`);
        if (await fs.pathExists(projectDestinationFolder)) {
            showProjectAlreadyExistsError();
            return undefined;
        }
        const createdPackage: PythonProject = {
            name: packageName,
            uri: Uri.file(projectDestinationFolder),
        };
        if (this.getExactProject(createdPackage.uri)) {
            showProjectAlreadyConfiguredError();
            return undefined;
        }

        if (createVenv === false) {
            const projectEnvManagers = this.envManagers.getProjectEnvManagers([createdPackage.uri]);
            while (createVenv === false && !selectedEnvironment) {
                try {
                    selectedEnvironment = await pickEnvironment(this.envManagers.managers, projectEnvManagers, {
                        projects: [createdPackage],
                        showBackButton: true,
                        showCreateEnvironment: false,
                    });
                } catch (ex) {
                    if (ex !== QuickInputButtons.Back) {
                        throw ex;
                    }
                    createVenv = await promptForVenv(restartCreation);
                    if (createVenv === undefined) {
                        return undefined;
                    }
                    continue;
                }
                if (!selectedEnvironment) {
                    return undefined;
                }
            }
        }

        let selectedEnvironmentManager: InternalEnvironmentManager | undefined;
        if (selectedEnvironment) {
            const manager = this.envManagers.getEnvironmentManager(selectedEnvironment);
            if (!manager) {
                throw new Error(
                    l10n.t(
                        'Environment manager {0} is no longer available.',
                        selectedEnvironment.envId.managerId,
                    ),
                );
            }
            selectedEnvironmentManager = manager;
        }

        let projectFolderOwned = false;
        try {
            await fs.mkdir(projectDestinationFolder);
            projectFolderOwned = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                showProjectAlreadyExistsError();
                return undefined;
            }
            throw error;
        }

        if (this.getExactProject(createdPackage.uri)) {
            await this.rollbackCreatedPackage(createdPackage, projectDestinationFolder, {
                projectFolderOwned,
                projectRegistrationOwned: false,
            });
            showProjectAlreadyConfiguredError();
            return undefined;
        }

        let projectRegistrationOwned = false;
        try {
            await fs.copy(newPackageTemplateFolder, projectDestinationFolder);

            // 2. Replace 'package_name' in all files and file/folder names using a helper
            await replaceInFilesAndNames(projectDestinationFolder, 'package_name', packageName);

            // add package to list of packages
            await this.projectManager.add(createdPackage);
            projectRegistrationOwned = this.getExactProject(createdPackage.uri) === createdPackage;
            if (!projectRegistrationOwned) {
                throw new Error(l10n.t('The new Python project could not be registered.'));
            }
        } catch (creationError) {
            projectRegistrationOwned = this.getExactProject(createdPackage.uri) === createdPackage;
            await this.rollbackCreatedPackage(createdPackage, projectDestinationFolder, {
                projectFolderOwned,
                projectRegistrationOwned,
            });
            throw creationError;
        }

        // 4. Create virtual environment if requested
        let createdEnv = selectedEnvironment;
        if (createVenv) {
            // gets default environment manager
            const en = this.envManagers.getEnvironmentManager(undefined);
            if (en?.supportsQuickCreate) {
                // opt to use quickCreate if available
                createdEnv = await en.create(Uri.file(projectDestinationFolder), { quickCreate: true });
            } else if (!options?.quickCreate && en?.supportsCreate) {
                // if quickCreate unavailable, use create method only if project is not quickCreate
                createdEnv = await en.create(Uri.file(projectDestinationFolder), {});
            } else {
                // get venv manager or any manager that supports quick creating environments
                const venvManager = this.envManagers.managers.find(
                    (m) => m.id === VENV_MANAGER_ID || m.supportsQuickCreate,
                );
                if (venvManager) {
                    createdEnv = await venvManager.create(Uri.file(projectDestinationFolder), {
                        quickCreate: true,
                    });
                } else {
                    const createCustomEnvironment = l10n.t('Create custom environment');
                    const action = await showErrorMessage(
                        l10n.t(
                            'A virtual environment could not be created for the new package "{0}" because your default environment manager does not support this operation and no alternative was available.',
                            packageName,
                        ),
                        createCustomEnvironment,
                    );
                    if (action === createCustomEnvironment) {
                        await executeCommand('python-envs.createAny', {
                            uri: createdPackage.uri,
                            selectEnvironment: true,
                        });
                        createdEnv = await this.envManagers.getEnvironment(createdPackage.uri);
                    }
                }
            }
        }
        // 5. Get the Python environment for the destination folder if not already created
        createdEnv = createdEnv || (await this.envManagers.getEnvironment(createdPackage.uri));
        if (!createdEnv) {
            showErrorMessage(l10n.t('Project created but unable to be correlated to correct Python environment.'));
            return undefined;
        }

        // 6. Set the Python environment for the package
        try {
            await this.envManagers.setEnvironment(createdPackage.uri, createdEnv);
        } catch (assignmentError) {
            if (selectedEnvironment) {
                await this.rollbackCreatedPackage(createdPackage, projectDestinationFolder, {
                    projectFolderOwned,
                    projectRegistrationOwned,
                    environmentManager: selectedEnvironmentManager,
                });
            }
            throw assignmentError;
        }

        // 7. add custom github copilot instructions
        if (createCopilotInstructions) {
            const packageInstructionsPath = path.join(
                NEW_PROJECT_TEMPLATES_FOLDER,
                'copilot-instructions-text',
                'package-copilot-instructions.md',
            );
            await manageCopilotInstructionsFile(destRoot, packageInstructionsPath, [
                { searchValue: '<package_name>', replaceValue: packageName },
            ]);
        }

        // update launch.json file with config for the package
        const launchJsonConfig = {
            name: `Python Package: ${packageName}`,
            type: 'debugpy',
            request: 'launch',
            module: packageName,
        };
        await manageLaunchJsonFile(destRoot, JSON.stringify(launchJsonConfig));

        return createdPackage;
    }
}
