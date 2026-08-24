// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Package Manager Roundtrip
 *
 * Verifies package lifecycle operations through the public API using disposable
 * environments. Each fixture owns both sides of the test:
 *
 *   1. Create an environment with the configured environment manager.
 *   2. Exercise the environment manager's preferred package manager.
 *   3. Remove the environment, even when the package roundtrip fails.
 *
 * Poetry and Pipenv are intentionally excluded until their environment lifecycle
 * setup can participate in the same disposable fixture contract.
 */

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import { Package, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import {
    CONDA_MANAGER_ID,
    DEFAULT_PACKAGE_MANAGER_ID,
    SYSTEM_MANAGER_ID,
    VENV_MANAGER_ID,
} from '../../common/constants';
import { normalizePackageName } from '../../managers/common/packageUtils';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

interface PackageManagerFixture {
    name: string;
    environmentManagerId: string;
    packageManagerId: string;
    alwaysUseUv?: boolean;
    isAvailable(environments: PythonEnvironment[]): boolean;
}

const TEST_PACKAGE = 'flask';

const PACKAGE_MANAGER_FIXTURES: PackageManagerFixture[] = [
    {
        name: 'Venv with Pip',
        environmentManagerId: VENV_MANAGER_ID,
        packageManagerId: DEFAULT_PACKAGE_MANAGER_ID,
        alwaysUseUv: false,
        isAvailable: (environments) =>
            environments.some(
                (environment) =>
                    environment.envId.managerId === SYSTEM_MANAGER_ID && environment.version.startsWith('3.'),
            ),
    },
    {
        name: 'Conda with Conda',
        environmentManagerId: CONDA_MANAGER_ID,
        packageManagerId: CONDA_MANAGER_ID,
        isAvailable: (environments) =>
            environments.some((environment) => environment.envId.managerId === CONDA_MANAGER_ID),
    },
];

type AvailableVersionsCapable = {
    getPackageAvailableVersions?: (
        environment: PythonEnvironment,
        packageName: string,
    ) => Promise<unknown[] | undefined>;
};

function hasPackage(packages: Package[] | undefined, name: string): boolean {
    const target = normalizePackageName(name);
    return (packages ?? []).some((pkg) => normalizePackageName(pkg.name) === target);
}

async function withManagerSettings<T>(
    fixture: PackageManagerFixture,
    scope: vscode.Uri,
    callback: () => Promise<T>,
): Promise<T> {
    const config = vscode.workspace.getConfiguration('python-envs', scope);
    const originalEnvironmentManager = config.inspect<string>('defaultEnvManager')?.workspaceValue;
    const originalPackageManager = config.inspect<string>('defaultPackageManager')?.workspaceValue;
    const originalAlwaysUseUv = config.inspect<boolean>('alwaysUseUv')?.globalValue;

    try {
        await config.update(
            'defaultEnvManager',
            fixture.environmentManagerId,
            vscode.ConfigurationTarget.Workspace,
        );
        await config.update(
            'defaultPackageManager',
            fixture.packageManagerId,
            vscode.ConfigurationTarget.Workspace,
        );
        if (fixture.alwaysUseUv !== undefined) {
            await config.update('alwaysUseUv', fixture.alwaysUseUv, vscode.ConfigurationTarget.Global);
        }
        return await callback();
    } finally {
        const restorations = [
            config.update(
                'defaultEnvManager',
                originalEnvironmentManager,
                vscode.ConfigurationTarget.Workspace,
            ),
            config.update(
                'defaultPackageManager',
                originalPackageManager,
                vscode.ConfigurationTarget.Workspace,
            ),
        ];
        if (fixture.alwaysUseUv !== undefined) {
            restorations.push(
                config.update('alwaysUseUv', originalAlwaysUseUv, vscode.ConfigurationTarget.Global),
            );
        }
        await Promise.all(restorations);
    }
}

async function runRoundtrip(
    api: PythonEnvironmentApi,
    environment: PythonEnvironment,
    packageManagerId: string,
): Promise<void> {
    const baseline = await api.getPackages(environment, { skipCache: true });
    assert.notStrictEqual(baseline, undefined, `[${packageManagerId}] Package manager should be available`);
    assert.ok(
        !hasPackage(baseline, TEST_PACKAGE),
        `[${packageManagerId}] ${TEST_PACKAGE} should be absent from the new environment`,
    );

    await api.managePackages(environment, { install: [TEST_PACKAGE] });

    await api.refreshPackages(environment);
    const afterInstall = await api.getPackages(environment, { skipCache: true });
    const installedPackage = (afterInstall ?? []).find(
        (pkg) => normalizePackageName(pkg.name) === normalizePackageName(TEST_PACKAGE),
    );
    assert.ok(installedPackage, `[${packageManagerId}] ${TEST_PACKAGE} should be installed`);
    assert.strictEqual(
        installedPackage.pkgId.managerId,
        packageManagerId,
        `[${packageManagerId}] ${TEST_PACKAGE} should use the expected package manager`,
    );
    assert.notStrictEqual(
        installedPackage.isTransitive,
        true,
        `[${packageManagerId}] ${TEST_PACKAGE} should be reported as a direct package`,
    );

    const classifiesTransitivity = (afterInstall ?? []).some((pkg) => pkg.isTransitive !== undefined);
    if (classifiesTransitivity) {
        assert.ok(
            (afterInstall ?? []).some((pkg) => pkg.isTransitive === true),
            `[${packageManagerId}] A ${TEST_PACKAGE} dependency should be reported as transitive`,
        );
    }

    const versionsApi = api as AvailableVersionsCapable;
    if (typeof versionsApi.getPackageAvailableVersions === 'function') {
        const versions = await versionsApi.getPackageAvailableVersions(environment, TEST_PACKAGE);
        if (versions !== undefined) {
            assert.ok(
                Array.isArray(versions) && versions.length > 0,
                `[${packageManagerId}] ${TEST_PACKAGE} should report available versions`,
            );
        }
    }

    await api.managePackages(environment, { uninstall: [TEST_PACKAGE] });
    await api.refreshPackages(environment);
    const afterUninstall = await api.getPackages(environment, { skipCache: true });
    assert.ok(!hasPackage(afterUninstall, TEST_PACKAGE), `[${packageManagerId}] ${TEST_PACKAGE} should be uninstalled`);
}

suite('Integration: Package Manager Roundtrip', function () {
    this.timeout(600_000); // Environment creation and Conda package solving can both be slow.

    let api: PythonEnvironmentApi;
    let originalTestExecution: string | undefined;

    suiteSetup(async function () {
        this.timeout(30_000);
        originalTestExecution = process.env.VSC_PYTHON_CI_TEST;
        process.env.VSC_PYTHON_CI_TEST = '1';

        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 20_000, 'Extension did not activate');
        }

        api = extension.exports as PythonEnvironmentApi;
        assert.ok(api, 'API not available');
    });

    suiteTeardown(() => {
        if (originalTestExecution === undefined) {
            delete process.env.VSC_PYTHON_CI_TEST;
        } else {
            process.env.VSC_PYTHON_CI_TEST = originalTestExecution;
        }
    });

    for (const fixture of PACKAGE_MANAGER_FIXTURES) {
        test(`${fixture.name}: disposable environment package roundtrip`, async function () {
            const globalEnvironments = await api.getEnvironments('global');
            if (!fixture.isAvailable(globalEnvironments)) {
                this.skip();
                return;
            }

            const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'python-envs-package-roundtrip-'));
            const project: PythonProject = {
                name: `Package roundtrip: ${fixture.name}`,
                uri: vscode.Uri.file(projectRoot),
            };
            let environment: PythonEnvironment | undefined;

            api.addPythonProject(project);

            try {
                await withManagerSettings(fixture, project.uri, async () => {
                    environment = await api.createEnvironment(project.uri, { quickCreate: true });
                    assert.ok(environment, `[${fixture.name}] Environment creation should succeed`);
                    assert.strictEqual(
                        environment.envId.managerId,
                        fixture.environmentManagerId,
                        `[${fixture.name}] Environment should use the expected manager`,
                    );

                    await runRoundtrip(api, environment, fixture.packageManagerId);
                });
            } finally {
                try {
                    if (environment) {
                        await api.removeEnvironment(environment);
                    }
                } finally {
                    api.removePythonProject(project);
                    await fs.remove(projectRoot);
                }
            }
        });
    }
});
