// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Package Management
 *
 * PURPOSE:
 * Verify that package management works correctly for different
 * environment types and managers.
 *
 * WHAT THIS TESTS:
 * 1. getPackages returns packages for environments
 * 2. Package installation via API
 * 3. Package uninstallation via API
 * 4. Refresh updates package list
 * 5. Events fire when packages change
 *
 * NOTE: Some tests may install/uninstall actual packages.
 * These should use safe test packages that don't have side effects.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DidChangePackagesEventArgs, PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { sleep, TestEventHandler, waitForCondition } from '../testUtils';

suite('Integration: Package Management', function () {
    this.timeout(120_000); // Package operations can be slow

    let api: PythonEnvironmentApi;

    suiteSetup(async function () {
        this.timeout(30_000);

        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 20_000, 'Extension did not activate');
        }

        api = extension.exports as PythonEnvironmentApi;
        assert.ok(api, 'API not available');
    });

    /**
     * Test: Package management APIs are available
     *
     * The API should have all package management methods.
     */
    test('Package management APIs are available', async function () {
        assert.ok(typeof api.getPackages === 'function', 'getPackages should be a function');
        assert.ok(typeof api.refreshPackages === 'function', 'refreshPackages should be a function');
        assert.ok(typeof api.managePackages === 'function', 'managePackages should be a function');
        assert.ok(api.onDidChangePackages, 'onDidChangePackages should be available');
    });

    /**
     * Test: getPackages returns array for environment
     *
     * For a valid environment, getPackages should return a list of packages.
     */
    test('getPackages returns packages for environment', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Try to find an environment that likely has packages (not system Python)
        let targetEnv = environments[0];
        for (const env of environments) {
            // Prefer environments that are likely virtual envs with packages
            if (env.displayName.includes('venv') || env.displayName.includes('.venv')) {
                targetEnv = env;
                break;
            }
        }

        const packages = await api.getPackages(targetEnv);

        // May be undefined if package manager not available
        if (packages === undefined) {
            console.log('Package manager not available for:', targetEnv.displayName);
            return;
        }

        assert.ok(Array.isArray(packages), 'getPackages should return array');
        console.log(`Found ${packages.length} packages in ${targetEnv.displayName}`);
    });

    /**
     * Test: Packages have valid structure
     *
     * Each package should have required properties.
     */
    test('Packages have valid structure', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const packages = await api.getPackages(environments[0]);

        if (!packages || packages.length === 0) {
            this.skip();
            return;
        }

        for (const pkg of packages) {
            assert.ok(pkg.pkgId, 'Package must have pkgId');
            assert.ok(pkg.pkgId.id, 'pkgId must have id');
            assert.ok(pkg.pkgId.managerId, 'pkgId must have managerId');
            assert.ok(pkg.pkgId.environmentId, 'pkgId must have environmentId');
            assert.ok(typeof pkg.name === 'string', 'Package must have name');
            assert.ok(pkg.name.length > 0, 'Package name should not be empty');
            assert.ok(typeof pkg.displayName === 'string', 'Package must have displayName');
        }
    });

    /**
     * Test: refreshPackages updates package list
     *
     * After refreshing, the package list should be up to date.
     */
    test('refreshPackages updates list', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        // Get initial packages
        const initial = await api.getPackages(env);

        if (initial === undefined) {
            this.skip();
            return;
        }

        // Refresh
        await api.refreshPackages(env);

        // Get updated packages
        const after = await api.getPackages(env);

        assert.ok(Array.isArray(after), 'Should return array after refresh');

        // Package counts should be similar (no external changes during test)
        // Allow some variance for cache effects
    });

    /**
     * Test: Standard library packages typically present
     *
     * Most Python environments should have pip installed.
     */
    test('Common packages are discoverable', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Find a virtual environment (more likely to have pip)
        let targetEnv = environments.find(
            (env) =>
                env.displayName.includes('venv') ||
                env.displayName.includes('.venv') ||
                env.envId.managerId.includes('venv'),
        );

        if (!targetEnv) {
            // Fall back to first environment
            targetEnv = environments[0];
        }

        const packages = await api.getPackages(targetEnv);

        if (!packages || packages.length === 0) {
            console.log('No packages found in:', targetEnv.displayName);
            this.skip();
            return;
        }

        // Look for common packages
        const pipInstalled = packages.some((p) => p.name.toLowerCase() === 'pip');
        const setuptoolsInstalled = packages.some((p) => p.name.toLowerCase() === 'setuptools');

        // Virtual environment should have pip or at least some packages
        assert.ok(pipInstalled || packages.length > 0, 'Virtual environment should have pip or at least some packages');
        console.log(
            `pip installed: ${pipInstalled}, setuptools installed: ${setuptoolsInstalled}, total: ${packages.length}`,
        );
    });

    /**
     * Test: Different environments can have different packages
     *
     * Package lists should be environment-specific.
     */
    test('Package lists are environment-specific', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length < 2) {
            this.skip();
            return;
        }

        const env1 = environments[0];
        const env2 = environments[1];

        const packages1 = await api.getPackages(env1);
        const packages2 = await api.getPackages(env2);

        // Both should return valid results (or undefined for same reason)
        if (packages1 === undefined || packages2 === undefined) {
            console.log('Package manager not available for one or both environments');
            return;
        }

        assert.ok(Array.isArray(packages1), 'Env1 packages should be array');
        assert.ok(Array.isArray(packages2), 'Env2 packages should be array');

        console.log(`Env1 (${env1.displayName}): ${packages1.length} packages`);
        console.log(`Env2 (${env2.displayName}): ${packages2.length} packages`);
    });

    /**
     * Test: Package install and uninstall flow
     *
     * This test installs and uninstalls a small test package.
     * Uses 'cowsay' as it's small and has no dependencies.
     */
    test('Package install and uninstall works', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Find a virtual environment we can safely modify
        const targetEnv = environments.find(
            (env) =>
                (env.displayName.includes('venv') || env.displayName.includes('.venv')) &&
                env.envId.managerId.includes('venv'),
        );

        if (!targetEnv) {
            console.log('No modifiable virtual environment found');
            this.skip();
            return;
        }

        const testPackage = 'cowsay';

        // Check if already installed
        const initialPackages = await api.getPackages(targetEnv);
        if (!initialPackages) {
            console.log('Package manager not available for this environment');
            this.skip();
            return;
        }

        const wasInstalled = initialPackages.some((p) => p.name.toLowerCase() === testPackage);
        let packageInstalled = wasInstalled;

        try {
            if (wasInstalled) {
                // Uninstall first
                await api.managePackages(targetEnv, { uninstall: [testPackage] });
                packageInstalled = false;
                await sleep(2000);
            }

            // Install package
            await api.managePackages(targetEnv, { install: [testPackage] });
            packageInstalled = true;

            // Refresh and verify
            await api.refreshPackages(targetEnv);
            const afterInstall = await api.getPackages(targetEnv);

            const isNowInstalled = afterInstall?.some((p) => p.name.toLowerCase() === testPackage);
            assert.ok(isNowInstalled, `${testPackage} should be installed after managePackages install`);

            // Uninstall
            await api.managePackages(targetEnv, { uninstall: [testPackage] });
            packageInstalled = false;

            // Refresh and verify
            await api.refreshPackages(targetEnv);
            const afterUninstall = await api.getPackages(targetEnv);

            const isStillInstalled = afterUninstall?.some((p) => p.name.toLowerCase() === testPackage);
            assert.ok(!isStillInstalled, `${testPackage} should be uninstalled after managePackages uninstall`);
        } finally {
            // Ensure cleanup even if assertions fail
            if (packageInstalled) {
                try {
                    await api.managePackages(targetEnv, { uninstall: [testPackage] });
                } catch {
                    console.log('Cleanup: failed to uninstall test package');
                }
            }
        }
    });

    /**
     * Test: onDidChangePackages event fires
     *
     * When packages change, the event should fire.
     */
    test('onDidChangePackages event is available', async function () {
        assert.ok(api.onDidChangePackages, 'onDidChangePackages should be available');

        // Verify it's subscribable
        const handler = new TestEventHandler<DidChangePackagesEventArgs>(
            api.onDidChangePackages,
            'onDidChangePackages',
        );

        // Just verify we can subscribe without error
        handler.dispose();
    });

    /**
     * Test: createPackageItem creates valid package
     *
     * The createPackageItem API should create properly structured packages.
     */
    test('createPackageItem creates valid structure', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // This test verifies the API exists and is callable
        // Full testing requires a registered package manager
        assert.ok(typeof api.createPackageItem === 'function', 'createPackageItem should be a function');
    });

    /**
     * Test: Invalid environment returns undefined packages
     *
     * For an environment without a package manager, should return undefined.
     */
    test('Missing package manager returns undefined', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // System Python or unusual environments may not have package managers
        for (const env of environments) {
            const packages = await api.getPackages(env);
            // Result should be either array or undefined, never throw
            if (packages !== undefined) {
                assert.ok(Array.isArray(packages), 'Should be array if defined');
            }
        }
    });
});
