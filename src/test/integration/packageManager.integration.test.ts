import * as vscode from 'vscode';

import assert from 'assert';
import * as path from 'path';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { CONDA_MANAGER_ID, DEFAULT_PACKAGE_MANAGER_ID, VENV_MANAGER_ID } from '../../common/constants';
import { PythonProjectSettings } from '../../internal.api';
import { isUvInstalled } from '../../managers/builtin/helpers';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

interface PackageManagerProfile {
    environmentManagerId: string;
    name: string;
    packageManagerId: string;
    projectDirectory: string;
    alwaysUseUv?: boolean;
}

const profiles: PackageManagerProfile[] = [
    {
        environmentManagerId: VENV_MANAGER_ID,
        name: 'Pip',
        packageManagerId: DEFAULT_PACKAGE_MANAGER_ID,
        projectDirectory: 'pip',
        alwaysUseUv: false,
    },
    {
        environmentManagerId: VENV_MANAGER_ID,
        name: 'Pip with uv',
        packageManagerId: DEFAULT_PACKAGE_MANAGER_ID,
        projectDirectory: 'pip-uv',
        alwaysUseUv: true,
    },
    {
        environmentManagerId: CONDA_MANAGER_ID,
        name: 'Conda',
        packageManagerId: CONDA_MANAGER_ID,
        projectDirectory: 'conda',
    },
];

for (const profile of profiles) {
    suite(`${profile.name} Package Manager`, function () {
        this.timeout(300_000);

        let api: PythonEnvironmentApi;
        let environment: PythonEnvironment | undefined;
        let project: PythonProject | undefined;
        let workspaceUri: vscode.Uri;
        let previousAlwaysUseUv: boolean | undefined;
        let alwaysUseUvUpdated = false;
        let previousPythonProjects: PythonProjectSettings[] | undefined;
        let pythonProjectsUpdated = false;
        suiteSetup(async function () {
            const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
            assert.ok(extension, 'Extension not found');
            if (!extension.isActive) {
                await extension.activate();
                await waitForCondition(() => extension.isActive, 20_000, 'Extension did not activate in time');
            }
            api = extension.exports;
            assert.ok(api, 'API not available');

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            assert.ok(workspaceFolder, 'Integration test workspace not found');
            workspaceUri = workspaceFolder.uri;
            const config = vscode.workspace.getConfiguration('python-envs', workspaceUri);

            if (profile.alwaysUseUv === true && !(await isUvInstalled())) {
                this.skip();
                return;
            }

            if (profile.alwaysUseUv !== undefined) {
                previousAlwaysUseUv = config.inspect<boolean>('alwaysUseUv')?.globalValue;
                await config.update('alwaysUseUv', profile.alwaysUseUv, vscode.ConfigurationTarget.Global);
                alwaysUseUvUpdated = true;
            }

            const projectUri = vscode.Uri.joinPath(
                workspaceUri,
                `.package-manager-test-${profile.projectDirectory}-${process.pid}`,
            );
            await vscode.workspace.fs.createDirectory(projectUri);
            project = {
                name: `${profile.name} Package Manager Test`,
                uri: projectUri,
            };
            previousPythonProjects = config.inspect<PythonProjectSettings[]>('pythonProjects')?.workspaceFolderValue;
            const pythonProjects = config.get<PythonProjectSettings[]>('pythonProjects', []);
            const projectSetting: PythonProjectSettings = {
                path: path.relative(workspaceUri.fsPath, projectUri.fsPath).replace(/\\/g, '/'),
                envManager: profile.environmentManagerId,
                packageManager: profile.packageManagerId,
                workspace: workspaceFolder.name,
            };
            await config.update(
                'pythonProjects',
                [...pythonProjects, projectSetting],
                vscode.ConfigurationTarget.WorkspaceFolder,
            );
            pythonProjectsUpdated = true;
            await waitForCondition(
                () =>
                    api
                        .getPythonProjects()
                        .some((registeredProject) => registeredProject.uri.toString() === projectUri.toString()),
                10_000,
                `Python project was not registered: ${projectUri.fsPath}`,
            );

            await api.refreshEnvironments(projectUri);

            environment = await api.createEnvironment(projectUri, { quickCreate: true });
            if (!environment) {
                this.skip();
                return;
            }
            assert.strictEqual(
                environment.envId.managerId,
                profile.environmentManagerId,
                `Expected an environment created by ${profile.environmentManagerId}`,
            );
        });

        test(`${profile.name} Package Manager should install, list, and uninstall a package`, async () => {
            await api.managePackages(environment!, { install: ['requests'], runHeadless: true });
            let packages = await api.getPackages(environment!, { skipCache: true });
            assert.ok(
                packages?.some((pkg) => pkg.name === 'requests'),
                'Package not installed',
            );

            await api.managePackages(environment!, { uninstall: ['requests'], runHeadless: true });
            packages = await api.getPackages(environment!, { skipCache: true });
            assert.ok(!packages?.some((pkg) => pkg.name === 'requests'), 'Package not uninstalled');
        });

        test(`${profile.name} Package Manager should list available package versions`, async function () {
            const versions = await api.getPackageAvailableVersions(environment!, 'requests');
            if (versions === undefined) {
                this.skip();
                return;
            }
            assert.ok(versions.length > 0, 'No package versions available');
        });

        suiteTeardown(async () => {
            try {
                if (environment) {
                    const environmentPath = environment.environmentPath;
                    await api.removeEnvironment(environment, { runHeadless: true });
                    await assert.rejects(
                        async () => vscode.workspace.fs.stat(environmentPath),
                        (error: unknown) =>
                            error instanceof vscode.FileSystemError && error.code === 'FileNotFound',
                        `Environment was not removed: ${environmentPath.fsPath}`,
                    );
                }
            } finally {
                const config = vscode.workspace.getConfiguration('python-envs', workspaceUri);
                try {
                    if (project) {
                        try {
                            await api.setEnvironment(project.uri, undefined);
                        } finally {
                            try {
                                if (pythonProjectsUpdated) {
                                    await config.update(
                                        'pythonProjects',
                                        previousPythonProjects,
                                        vscode.ConfigurationTarget.WorkspaceFolder,
                                    );
                                    await waitForCondition(
                                        () =>
                                            !api
                                                .getPythonProjects()
                                                .some(
                                                    (registeredProject) =>
                                                        registeredProject.uri.toString() === project!.uri.toString(),
                                                ),
                                        10_000,
                                        `Python project was not unregistered: ${project.uri.fsPath}`,
                                    );
                                }
                            } finally {
                                await vscode.workspace.fs.delete(project.uri, {
                                    recursive: true,
                                    useTrash: false,
                                });
                            }
                        }
                    }
                } finally {
                    if (alwaysUseUvUpdated) {
                        await config.update('alwaysUseUv', previousAlwaysUseUv, vscode.ConfigurationTarget.Global);
                    }
                }
            }
        });
    });
}
