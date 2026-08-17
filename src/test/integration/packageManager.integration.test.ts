import * as vscode from 'vscode';

import assert from 'assert';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { CONDA_MANAGER_ID, VENV_MANAGER_ID } from '../../common/constants';
import { isUvInstalled } from '../../managers/builtin/helpers';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

interface PackageManagerProfile {
    environmentManagerId: string;
    name: string;
    alwaysUseUv?: boolean;
}

const profiles: PackageManagerProfile[] = [
    {
        environmentManagerId: VENV_MANAGER_ID,
        name: 'Pip',
        alwaysUseUv: false,
    },
    {
        environmentManagerId: VENV_MANAGER_ID,
        name: 'Pip with uv',
        alwaysUseUv: true,
    },
    {
        environmentManagerId: CONDA_MANAGER_ID,
        name: 'Conda',
    },
];

for (const profile of profiles) {
    suite(`${profile.name} Package Manager`, function () {
        this.timeout(300_000);

        let api: PythonEnvironmentApi;
        let environment: PythonEnvironment | undefined;
        let workspaceUri: vscode.Uri;
        let previousDefaultEnvManager: string | undefined;
        let defaultEnvManagerUpdated = false;
        let previousAlwaysUseUv: boolean | undefined;
        let alwaysUseUvUpdated = false;
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

            previousDefaultEnvManager = config.inspect<string>('defaultEnvManager')?.workspaceValue;
            await config.update(
                'defaultEnvManager',
                profile.environmentManagerId,
                vscode.ConfigurationTarget.Workspace,
            );
            defaultEnvManagerUpdated = true;

            if (profile.alwaysUseUv !== undefined) {
                previousAlwaysUseUv = config.inspect<boolean>('alwaysUseUv')?.globalValue;
                await config.update('alwaysUseUv', profile.alwaysUseUv, vscode.ConfigurationTarget.Global);
                alwaysUseUvUpdated = true;
            }

            await api.refreshEnvironments(workspaceUri);

            environment = await api.createEnvironment(workspaceUri, { quickCreate: true });
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
                    if (alwaysUseUvUpdated) {
                        await config.update('alwaysUseUv', previousAlwaysUseUv, vscode.ConfigurationTarget.Global);
                    }
                } finally {
                    if (defaultEnvManagerUpdated) {
                        await config.update(
                            'defaultEnvManager',
                            previousDefaultEnvManager,
                            vscode.ConfigurationTarget.Workspace,
                        );
                    }
                }
            }
        });
    });
}
