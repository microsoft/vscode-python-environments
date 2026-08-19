import * as vscode from 'vscode';

import { compare } from '@renovatebot/pep440';
import assert from 'assert';
import * as path from 'path';
import { Package, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { CONDA_MANAGER_ID, DEFAULT_PACKAGE_MANAGER_ID, VENV_MANAGER_ID } from '../../common/constants';
import { PythonProjectSettings } from '../../internal.api';
import { getConda } from '../../managers/conda/condaUtils';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

type PackageManagerId = `${string}:${string}`;

interface PackageManagerProfile {
    environmentManagerId: string;
    name: string;
    packageName: string;
    packageManagerId: PackageManagerId;
    projectDirectory: string;
    prerequisite(api: PythonEnvironmentApi): Promise<boolean>;
    reuseExistingEnvironment?: boolean;
    supportsVersionLookup(packages: Package[]): boolean;
}

const profiles: PackageManagerProfile[] = [
    {
        environmentManagerId: VENV_MANAGER_ID,
        name: 'Pip',
        packageName: 'requests',
        packageManagerId: DEFAULT_PACKAGE_MANAGER_ID,
        projectDirectory: 'pip',
        prerequisite: async (api) =>
            (await api.getEnvironments('global')).some((environment) => environment.version.startsWith('3.')),
        supportsVersionLookup: (packages) => {
            const pipVersion = packages.find((pkg) => pkg.name.toLowerCase() === 'pip')?.version;
            return pipVersion !== undefined && compare(pipVersion, '21.2') >= 0;
        },
    },
    {
        environmentManagerId: CONDA_MANAGER_ID,
        name: 'Conda',
        packageName: 'flask',
        packageManagerId: CONDA_MANAGER_ID,
        projectDirectory: 'conda',
        prerequisite: async () => {
            try {
                await getConda();
                return true;
            } catch {
                return false;
            }
        },
        reuseExistingEnvironment: true,
        supportsVersionLookup: () => true,
    },
];

const deferredPackageManagers: Readonly<Record<PackageManagerId, string>> = {
    'ms-python.python:poetry': 'Poetry lifecycle coverage requires a controlled Poetry installation.',
};

const deferredProfiles = {
    pipWithUv: 'uv-backed Pip selection uses a machine-scoped setting and is unstable within one extension host.',
} as const;

suite('Package Manager profile coverage', function () {
    this.timeout(60_000);

    test('covers or explicitly defers every registered package manager', async () => {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');
        const api: PythonEnvironmentApi = extension.isActive ? extension.exports : await extension.activate();
        await api.getEnvironments('global');

        const registeredIds = await vscode.commands.executeCommand<string[]>(
            'python-envs.test.getPackageManagerIds',
        );
        assert.ok(registeredIds, 'Registered package-manager IDs are unavailable');

        const coveredIds = new Set(profiles.map((profile) => profile.packageManagerId));
        const uncoveredIds = registeredIds.filter(
            (managerId) =>
                !coveredIds.has(managerId as PackageManagerId) &&
                deferredPackageManagers[managerId as PackageManagerId] === undefined,
        );
        assert.deepStrictEqual(uncoveredIds, [], `Package managers lack lifecycle coverage: ${uncoveredIds.join(', ')}`);

        for (const profile of profiles) {
            assert.ok(
                registeredIds.includes(profile.packageManagerId),
                `Profile references an unregistered package manager: ${profile.packageManagerId}`,
            );
        }

        for (const [profileName, reason] of Object.entries(deferredProfiles)) {
            assert.ok(reason.length > 0, `Deferred profile lacks a reason: ${profileName}`);
        }
    });
});

for (const profile of profiles) {
    suite(`${profile.name} Package Manager`, function () {
        this.timeout(300_000);

        let api: PythonEnvironmentApi;
        let environment: PythonEnvironment | undefined;
        let project: PythonProject | undefined;
        let workspaceUri: vscode.Uri;
        let previousAlwaysUseUv: boolean | undefined;
        let previousPythonProjects: PythonProjectSettings[] | undefined;
        let alwaysUseUvUpdated = false;
        let createdEnvironment = false;
        let pythonProjectsUpdated = false;
        suiteSetup(async function () {
            if (process.env.VSC_PYTHON_PACKAGE_NETWORK_TEST !== '1') {
                this.skip();
                return;
            }

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

            if (profile.packageManagerId === DEFAULT_PACKAGE_MANAGER_ID) {
                previousAlwaysUseUv = config.inspect<boolean>('alwaysUseUv')?.globalValue;
                await config.update('alwaysUseUv', false, vscode.ConfigurationTarget.Global);
                alwaysUseUvUpdated = true;
            }

            if (!(await profile.prerequisite(api))) {
                this.skip();
                return;
            }

            if (profile.reuseExistingEnvironment) {
                await api.refreshEnvironments(undefined);
                environment = (await api.getEnvironments('global')).find(
                    (candidate) => candidate.envId.managerId === profile.environmentManagerId,
                );
                assert.ok(environment, `No existing ${profile.name} environment is available`);
                return;
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
            createdEnvironment = environment !== undefined;
            assert.ok(environment, `${profile.name} failed to create an environment after prerequisites passed`);
            assert.strictEqual(
                environment.envId.managerId,
                profile.environmentManagerId,
                `Expected an environment created by ${profile.environmentManagerId}`,
            );
        });

        test(`${profile.name} Package Manager should install, list, and uninstall a package`, async () => {
            const packageName = profile.packageName;
            const baseline = await api.getPackages(environment!, { skipCache: true });
            assert.ok(baseline, 'Unable to list packages before installation');
            const wasInstalled = baseline.some((pkg) => pkg.name.toLowerCase() === packageName);

            if (!wasInstalled) {
                await api.managePackages(environment!, { install: [packageName], runHeadless: true });
            }
            let packages = await api.getPackages(environment!, { skipCache: true });
            assert.ok(packages, 'Unable to list packages after installation');
            assert.ok(
                packages.some((pkg) => pkg.name.toLowerCase() === packageName),
                'Package not installed',
            );

            const directPackageNames = await vscode.commands.executeCommand<string[] | undefined>(
                'python-envs.test.getDirectPackageNames',
                environment!,
            );
            if (directPackageNames !== undefined) {
                assert.ok(directPackageNames.includes(packageName), 'Installed package was not reported as direct');
            }

            if (!wasInstalled) {
                await api.managePackages(environment!, { uninstall: [packageName], runHeadless: true });
                packages = await api.getPackages(environment!, { skipCache: true });
                assert.ok(packages, 'Unable to list packages after uninstallation');
                assert.ok(
                    !packages.some((pkg) => pkg.name.toLowerCase() === packageName),
                    'Package not uninstalled',
                );
            }
        });

        test(`${profile.name} Package Manager should list available package versions`, async function () {
            const packages = await api.getPackages(environment!, { skipCache: true });
            assert.ok(packages, 'Unable to list packages before version lookup');
            if (!profile.supportsVersionLookup(packages)) {
                this.skip();
                return;
            }

            const versions = await api.getPackageAvailableVersions(environment!, profile.packageName);
            assert.ok(versions, `${profile.name} unexpectedly failed to retrieve package versions`);
            assert.ok(versions.length > 0, 'No package versions available');
        });

        suiteTeardown(async () => {
            try {
                if (environment && createdEnvironment) {
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
                        await api.setEnvironment(project.uri, undefined);
                    }
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
                            `Python project was not unregistered: ${project!.uri.fsPath}`,
                        );
                    }
                } finally {
                    try {
                        if (alwaysUseUvUpdated) {
                            await config.update(
                                'alwaysUseUv',
                                previousAlwaysUseUv,
                                vscode.ConfigurationTarget.Global,
                            );
                        }
                    } finally {
                        if (project) {
                            await vscode.workspace.fs.delete(project.uri, {
                                recursive: true,
                                useTrash: false,
                            });
                        }
                    }
                }
            }
        });
    });
}
