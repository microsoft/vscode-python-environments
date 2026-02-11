// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * E2E Test: Environment Discovery
 *
 * PURPOSE:
 * Verify that the extension can discover Python environments on the system.
 * This is a fundamental workflow - if discovery fails, users can't select interpreters.
 *
 * WHAT THIS TESTS:
 * 1. Extension API is accessible
 * 2. Environment discovery runs successfully
 * 3. At least one Python environment is found (assumes Python is installed)
 * 4. Environment objects have expected properties
 *
 * PREREQUISITES:
 * - Python must be installed on the test machine
 * - At least one Python environment should be discoverable (system Python, venv, conda, etc.)
 *
 * HOW TO RUN:
 * Option 1: VS Code - Use "E2E Tests" launch configuration
 * Option 2: Terminal - npm run e2e-test
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('E2E: Environment Discovery', function () {
    // E2E can be slower but 2x activation time is excessive
    this.timeout(90_000);

    // The API is FLAT - methods are directly on the api object, not nested
    let api: {
        getEnvironments(scope: 'all' | 'global'): Promise<unknown[]>;
        refreshEnvironments(scope: undefined): Promise<void>;
    };

    suiteSetup(async function () {
        // Get and activate the extension
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 30_000, 'Extension did not activate');
        }

        // Get the API - it's a flat interface, not nested
        api = extension.exports;
        assert.ok(api, 'Extension API not available');
        assert.ok(typeof api.getEnvironments === 'function', 'getEnvironments method not available');
    });

    /**
     * Test: Can trigger environment refresh
     *
     * WHY THIS MATTERS:
     * Users need to be able to refresh environments when they install new Python versions
     * or create new virtual environments outside VS Code.
     */
    test('Can trigger environment refresh', async function () {
        // Skip if API doesn't have refresh method
        if (typeof api.refreshEnvironments !== 'function') {
            this.skip();
            return;
        }

        // Capture state before refresh to verify API is callable
        const beforeRefresh = await api.getEnvironments('all');
        assert.ok(Array.isArray(beforeRefresh), 'Should get environments before refresh');

        // Trigger refresh - this should complete without throwing
        await api.refreshEnvironments(undefined);

        // Verify API still works after refresh (observable side effect: API remains functional)
        const afterRefresh = await api.getEnvironments('all');
        assert.ok(Array.isArray(afterRefresh), 'Should get environments after refresh');

        // Environments should still be available after refresh
        // (count may change if discovery finds more, but should not lose all)
        if (beforeRefresh.length > 0) {
            assert.ok(afterRefresh.length > 0, 'Should not lose all environments after refresh');
        }
    });

    /**
     * Test: Discovers at least one environment
     *
     * WHY THIS MATTERS:
     * The primary value of this extension is discovering Python environments.
     * If no environments are found, the extension isn't working.
     *
     * ASSUMPTIONS:
     * - Test machine has Python installed somewhere
     * - Discovery timeout is sufficient for the machine
     */
    test('Discovers at least one environment', async function () {
        // Wait for discovery to find at least one environment
        let environments: unknown[] = [];

        await waitForCondition(
            async () => {
                environments = await api.getEnvironments('all');
                return environments.length > 0;
            },
            60_000, // 60 seconds for discovery
            'No Python environments discovered. Ensure Python is installed on the test machine.',
        );

        assert.ok(environments.length > 0, `Expected at least 1 environment, found ${environments.length}`);
    });

    /**
     * Test: Discovered environments have required properties
     *
     * WHY THIS MATTERS:
     * Other parts of the extension and external consumers depend on environment
     * objects having certain properties. This catches schema regressions.
     */
    test('Environments have required properties', async function () {
        const environments = await api.getEnvironments('all');

        // Skip if no environments (previous test would have caught this)
        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0] as Record<string, unknown>;

        // Check required properties exist AND have valid values
        // PythonEnvironment has envId (a PythonEnvironmentId object), not id directly
        assert.ok('envId' in env, 'Environment should have an envId property');
        assert.ok(env.envId !== null && env.envId !== undefined, 'envId should not be null/undefined');

        // Verify envId structure
        const envId = env.envId as Record<string, unknown>;
        assert.strictEqual(typeof envId, 'object', 'envId should be an object');
        assert.ok('id' in envId, 'envId should have an id property');
        assert.strictEqual(typeof envId.id, 'string', 'envId.id should be a string');
        assert.ok((envId.id as string).length > 0, 'envId.id should not be empty');
        assert.ok('managerId' in envId, 'envId should have a managerId property');

        // Verify name exists and is a string
        assert.ok('name' in env, 'Environment should have a name property');
        assert.strictEqual(typeof env.name, 'string', 'name should be a string');

        // Verify displayName exists and is a string
        assert.ok('displayName' in env, 'Environment should have a displayName property');
        assert.strictEqual(typeof env.displayName, 'string', 'displayName should be a string');

        // If execInfo exists, it should have expected shape with valid values
        if ('execInfo' in env && env.execInfo) {
            const execInfo = env.execInfo as Record<string, unknown>;
            assert.strictEqual(typeof execInfo, 'object', 'execInfo should be an object');
            assert.ok(
                'run' in execInfo || 'activatedRun' in execInfo,
                'execInfo should have run or activatedRun property',
            );

            // Verify run command structure if present
            if ('run' in execInfo && execInfo.run) {
                const run = execInfo.run as Record<string, unknown>;
                assert.ok('executable' in run, 'run should have an executable property');
                assert.strictEqual(typeof run.executable, 'string', 'executable should be a string');
                assert.ok((run.executable as string).length > 0, 'executable should not be empty');
            }
        }
    });

    /**
     * Test: Can get global environments
     *
     * WHY THIS MATTERS:
     * Users often want to see system-wide Python installations separate from
     * workspace-specific virtual environments.
     */
    test('Can get global environments', async function () {
        // This should not throw, even if there are no global environments
        const globalEnvs = await api.getEnvironments('global');

        // Verify it returns an array
        assert.ok(Array.isArray(globalEnvs), 'getEnvironments should return an array');

        // If there are global envs, verify they have valid structure
        if (globalEnvs.length > 0) {
            const env = globalEnvs[0] as Record<string, unknown>;

            // Global environments should have the same structure as all environments
            assert.ok('envId' in env || 'id' in env, 'Global environment should have an identifier');

            // Verify envId is properly structured if present
            if ('envId' in env && env.envId) {
                const envId = env.envId as Record<string, unknown>;
                assert.strictEqual(typeof envId, 'object', 'envId should be an object');
                assert.ok('id' in envId, 'envId should have an id property');
            }
        }

        // Global envs should be a subset of all envs
        const allEnvs = await api.getEnvironments('all');
        assert.ok(
            globalEnvs.length <= allEnvs.length,
            `Global envs (${globalEnvs.length}) should not exceed all envs (${allEnvs.length})`,
        );
    });
});
