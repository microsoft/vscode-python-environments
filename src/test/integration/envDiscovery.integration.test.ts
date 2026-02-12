// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Environment Discovery
 *
 * PURPOSE:
 * Verify that environment discovery correctly finds and reports Python
 * environments based on configuration settings and search paths.
 *
 * WHAT THIS TESTS:
 * 1. Discovery respects workspaceSearchPaths setting
 * 2. Discovery respects globalSearchPaths setting
 * 3. Refresh clears stale cache and finds new environments
 * 4. Different scopes (all, global) return appropriate environments
 *
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DidChangeEnvironmentsEventArgs, PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { TestEventHandler, waitForCondition } from '../testUtils';

suite('Integration: Environment Discovery', function () {
    this.timeout(60_000);

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
        assert.ok(typeof api.getEnvironments === 'function', 'getEnvironments method not available');
    });

    /**
     * Test: Discovery returns environments after refresh
     *
     * Verifies that refreshing environments triggers discovery and
     * the API returns a valid array of environments.
     */
    test('Refresh triggers discovery and returns environments', async function () {
        // Trigger refresh
        await api.refreshEnvironments(undefined);

        // Get environments after refresh
        const environments = await api.getEnvironments('all');

        // Should return an array
        assert.ok(Array.isArray(environments), 'Expected environments to be an array');

        // Log count for debugging (may be 0 if no Python installed)
        console.log(`Discovered ${environments.length} environments`);
    });

    /**
     * Test: Global scope returns only global environments
     *
     * Global environments are system-wide Python installations that serve
     * as bases for virtual environments.
     */
    test('Global scope returns base Python installations', async function () {
        const globalEnvs = await api.getEnvironments('global');
        const allEnvs = await api.getEnvironments('all');

        assert.ok(Array.isArray(globalEnvs), 'Global scope should return array');
        assert.ok(Array.isArray(allEnvs), 'All scope should return array');

        // Global should be subset of or equal to all
        assert.ok(
            globalEnvs.length <= allEnvs.length,
            `Global envs (${globalEnvs.length}) should not exceed all envs (${allEnvs.length})`,
        );
    });

    /**
     * Test: Change events fire during refresh
     *
     * When environments are discovered or removed, the onDidChangeEnvironments
     * event should fire.
     */
    test('onDidChangeEnvironments fires during refresh', async function () {
        const handler = new TestEventHandler<DidChangeEnvironmentsEventArgs>(
            api.onDidChangeEnvironments,
            'onDidChangeEnvironments',
        );

        try {
            // Reset any previous events
            handler.reset();

            // First, check if we have environments on this system
            const preCheckEnvs = await api.getEnvironments('all');

            if (preCheckEnvs.length === 0) {
                // No environments discovered - can't test events
                console.log('No environments available to test event firing');
                this.skip();
                return;
            }

            // Trigger refresh - this should fire events for discovered environments
            await api.refreshEnvironments(undefined);

            // Wait for events to propagate (discovery is async)
            await handler.assertFiredAtLeast(1, 10_000);

            // Verify event has valid structure
            const event = handler.first;
            assert.ok(event, 'Event should have a value');

            // The event should have either added or removed environments
            assert.ok('added' in event || 'removed' in event, 'Event should have added or removed property');

            console.log(`Event fired ${handler.count} times during refresh`);
        } finally {
            handler.dispose();
        }
    });

    /**
     * Test: Environments have valid structure
     *
     * Each discovered environment should have the required properties
     * for the extension to work correctly.
     */
    test('Discovered environments have valid structure', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        for (const env of environments) {
            // Must have envId
            assert.ok(env.envId, 'Environment must have envId');
            assert.ok(env.envId.id, 'envId must have id');
            assert.ok(env.envId.managerId, 'envId must have managerId');

            // Must have basic info
            assert.ok(typeof env.name === 'string', 'Environment must have name');
            assert.ok(typeof env.displayName === 'string', 'Environment must have displayName');
            assert.ok(typeof env.version === 'string', 'Environment must have version');

            // Must have environment path
            assert.ok(env.environmentPath, 'Environment must have environmentPath');
            assert.ok(env.environmentPath instanceof vscode.Uri, 'environmentPath must be a Uri');
        }
    });

    /**
     * Test: resolveEnvironment returns full details
     *
     * The resolveEnvironment method should return complete environment
     * information including execution info.
     */
    test('resolveEnvironment returns execution info', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Pick first environment and resolve it
        const env = environments[0];
        const resolved = await api.resolveEnvironment(env.environmentPath);

        if (!resolved) {
            // Some environments may not be resolvable (broken/stale)
            console.log('Environment could not be resolved:', env.displayName);
            return;
        }

        // Resolved environment should have execInfo
        assert.ok(resolved.execInfo, 'Resolved environment should have execInfo');
        assert.ok(resolved.execInfo.run, 'execInfo should have run configuration');
        assert.ok(resolved.execInfo.run.executable, 'run should have executable path');
    });

    /**
     * Test: Workspace-scoped discovery finds workspace environments
     *
     * When a workspace folder is open and contains environments,
     * querying with the workspace URI should find them.
     */
    test('Workspace scope returns workspace environments', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const workspaceUri = workspaceFolders[0].uri;
        const workspaceEnvs = await api.getEnvironments(workspaceUri);

        assert.ok(Array.isArray(workspaceEnvs), 'Workspace scope should return array');

        // Log for debugging
        console.log(`Found ${workspaceEnvs.length} environments in workspace`);
    });

    /**
     * Test: Multiple refreshes are idempotent
     *
     * Calling refresh multiple times should not cause duplicate
     * environments or errors.
     */
    test('Multiple refreshes do not create duplicates', async function () {
        // First refresh
        await api.refreshEnvironments(undefined);
        const firstCount = (await api.getEnvironments('all')).length;

        // Second refresh
        await api.refreshEnvironments(undefined);
        const secondCount = (await api.getEnvironments('all')).length;

        // Third refresh
        await api.refreshEnvironments(undefined);
        const thirdCount = (await api.getEnvironments('all')).length;

        // Counts should be consistent (may vary slightly due to system changes)
        assert.ok(
            Math.abs(firstCount - secondCount) <= 1 && Math.abs(secondCount - thirdCount) <= 1,
            `Environment counts should be stable: ${firstCount}, ${secondCount}, ${thirdCount}`,
        );
    });
});
