import * as vscode from 'vscode';

import { compare } from '@renovatebot/pep440';
import assert from 'assert';
import {
    Package,
    PackageManagementOptions,
    PythonEnvironment,
    PythonEnvironmentApi,
    isPackageVersionLookupNotSupportedError,
} from '../../api';
import { CONDA_MANAGER_ID, DEFAULT_PACKAGE_MANAGER_ID } from '../../common/constants';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';
import {
    createCondaFixtureProvider,
    createEnvironmentFixture,
    createVenvFixtureProvider,
    EnvironmentFixture,
    EnvironmentFixtureProvider,
} from './environmentFixture';

type PackageManagerId = `${string}:${string}`;

interface PackageManagerProfile {
    name: string;
    packageName: string;
    packageManagerId: PackageManagerId;
    provider: EnvironmentFixtureProvider;
    supportsVersionLookup(packages: Package[]): boolean | undefined;
}

const profiles: PackageManagerProfile[] = [
    {
        name: 'Pip',
        packageName: 'requests',
        packageManagerId: DEFAULT_PACKAGE_MANAGER_ID,
        provider: createVenvFixtureProvider(),
        supportsVersionLookup: (packages) => {
            const pipVersion = packages.find((pkg) => pkg.name.toLowerCase() === 'pip')?.version;
            return pipVersion === undefined ? undefined : compare(pipVersion, '21.2') >= 0;
        },
    },
    {
        name: 'uv',
        packageName: 'requests',
        packageManagerId: 'ms-python.python:uv',
        provider: createVenvFixtureProvider(),
        supportsVersionLookup: () => true,
    },
    {
        name: 'Conda',
        packageName: 'flask',
        packageManagerId: CONDA_MANAGER_ID,
        provider: createCondaFixtureProvider(),
        supportsVersionLookup: () => true,
    },
];

const deferredPackageManagers: Readonly<Record<PackageManagerId, string>> = {
    'ms-python.python:poetry': 'Poetry lifecycle coverage requires a controlled Poetry installation.',
};

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
        assert.ok(registeredIds.includes('ms-python.python:uv'), 'uv package manager is not registered');

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

    });
});

for (const profile of profiles) {
    suite(`${profile.name} Package Manager`, function () {
        this.timeout(600_000);

        let api: PythonEnvironmentApi;
        let environment: PythonEnvironment | undefined;
        let fixture: EnvironmentFixture | undefined;
        let previousAlwaysUseUv: boolean | undefined;
        let alwaysUseUvUpdated = false;
        const useProjectManager = profile.packageManagerId === 'ms-python.python:uv';
        const getPackages = () => useProjectManager
            ? vscode.commands.executeCommand<Package[] | undefined>(
                'python-envs.test.getPackagesForProject', fixture!.projectUri, environment!,
            )
            : api.getPackages(environment!, { skipCache: true });
        const managePackages = (options: PackageManagementOptions) => useProjectManager
            ? vscode.commands.executeCommand<void>(
                'python-envs.test.managePackagesForProject', fixture!.projectUri, environment!, options,
            )
            : api.managePackages(environment!, options);

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
            const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder.uri);

            if (profile.packageManagerId === DEFAULT_PACKAGE_MANAGER_ID || useProjectManager) {
                previousAlwaysUseUv = config.inspect<boolean>('alwaysUseUv')?.globalValue;
                await config.update('alwaysUseUv', false, vscode.ConfigurationTarget.Global);
                alwaysUseUvUpdated = true;
            }

            fixture = await createEnvironmentFixture(api, workspaceFolder, {
                name: `${profile.name} Package Manager Test`,
                packageManagerId: profile.packageManagerId,
                provider: profile.provider,
                parentDirectory: useProjectManager ? workspaceFolder.uri : undefined,
            });
            environment = fixture.environment;
            if (useProjectManager) {
                assert.strictEqual(
                    vscode.workspace.getConfiguration('python-envs', fixture.projectUri).get('alwaysUseUv'),
                    false,
                    'Explicit uv selection must be tested without automatic uv routing',
                );
            }
            assert.strictEqual(
                environment.envId.managerId,
                profile.provider.managerId,
                `Expected an environment created by ${profile.provider.managerId}`,
            );
        });

        test(`${profile.name} Package Manager should install, list, and uninstall a package`, async () => {
            const packageName = profile.packageName;
            const baseline = await getPackages();
            assert.ok(baseline, 'Unable to list packages before installation');
            assert.ok(
                baseline.every((pkg) => pkg.pkgId.managerId === profile.packageManagerId),
                `${profile.name} lifecycle used an unexpected package manager`,
            );
            const wasInstalled = baseline.some((pkg) => pkg.name.toLowerCase() === packageName);

            if (!wasInstalled) {
                await managePackages({ install: [packageName], runHeadless: true });
            }
            let packages: Package[] | undefined;
            await waitForCondition(
                async () => {
                    packages = await getPackages();
                    return packages?.some((pkg) => pkg.name.toLowerCase() === packageName) ?? false;
                },
                30_000,
                'Package not installed',
                1_000,
                true,
                true,
            );

            const directPackageNames = await vscode.commands.executeCommand<string[] | undefined>(
                'python-envs.test.getDirectPackageNames',
                environment!,
                useProjectManager ? fixture!.projectUri : undefined,
            );
            if (directPackageNames !== undefined) {
                assert.ok(directPackageNames.includes(packageName), 'Installed package was not reported as direct');
            }

            if (!wasInstalled) {
                await managePackages({ uninstall: [packageName], runHeadless: true });
                await waitForCondition(
                    async () => {
                        packages = await getPackages();
                        return packages !== undefined && !packages.some((pkg) => pkg.name.toLowerCase() === packageName);
                    },
                    30_000,
                    'Package not uninstalled',
                    1_000,
                    true,
                    true,
                );
            }
        });

        test(`${profile.name} Package Manager should list available package versions`, async function () {
            const packages = await getPackages();
            assert.ok(packages, 'Unable to list packages before version lookup');
            const supportsVersionLookup = profile.supportsVersionLookup(packages);
            assert.notStrictEqual(
                supportsVersionLookup,
                undefined,
                `${profile.name} version lookup capability could not be determined`,
            );

            let versions;
            try {
                versions = useProjectManager
                    ? await vscode.commands.executeCommand<string[]>(
                        'python-envs.test.getPackageAvailableVersionsForProject',
                        fixture!.projectUri,
                        environment!,
                        profile.packageName,
                    )
                    : await api.getPackageAvailableVersions(environment!, profile.packageName, {
                        errorMode: 'throw',
                    });
            } catch (error) {
                if (isPackageVersionLookupNotSupportedError(error)) {
                    assert.strictEqual(
                        supportsVersionLookup,
                        false,
                        `${profile.name} unexpectedly reported version lookup as unsupported`,
                    );
                    this.skip();
                    return;
                }
                throw error;
            }

            assert.strictEqual(
                supportsVersionLookup,
                true,
                `${profile.name} returned versions despite declaring lookup unsupported`,
            );
            assert.ok(versions, `${profile.name} unexpectedly returned no package versions`);
            assert.ok(versions.length > 0, 'No package versions available');
        });

        suiteTeardown(async () => {
            try {
                if (fixture) {
                    await fixture.dispose();
                }
            } finally {
                if (alwaysUseUvUpdated) {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    assert.ok(workspaceFolder, 'Integration test workspace not found during teardown');
                    const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder.uri);
                    await config.update('alwaysUseUv', previousAlwaysUseUv, vscode.ConfigurationTarget.Global);
                }
            }
        });
    });
}
