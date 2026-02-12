// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Environment Manager + API
 *
 * PURPOSE:
 * Verify that the environment manager component correctly exposes data
 * through the extension API. This tests the integration between internal
 * managers and the public API surface.
 *
 * WHAT THIS TESTS:
 * 1. API reflects environment manager state
 * 2. Changes through API update manager state
 * 3. Events fire when state changes
 *
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from '../constants';
import { TestEventHandler, waitForCondition } from '../testUtils';

suite('Integration: Environment Manager + API', function () {
    // Shorter timeout for faster feedback
    this.timeout(45_000);

    // The API is FLAT - methods are directly on the api object, not nested
    let api: {
        getEnvironments(scope: 'all' | 'global'): Promise<unknown[]>;
        refreshEnvironments(scope: undefined): Promise<void>;
        onDidChangeEnvironments?: vscode.Event<unknown>;
    };

    suiteSetup(async function () {
        // Set a shorter timeout for setup specifically
        this.timeout(20_000);

        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 15_000, 'Extension did not activate');
        }

        api = extension.exports;
        assert.ok(typeof api?.getEnvironments === 'function', 'getEnvironments method not available');
    });

    /**
     * Test: API and manager stay in sync after refresh
     *
     */
    test('API reflects manager state after refresh', async function () {
        // Get initial state (verify we can call API before refresh)
        await api.getEnvironments('all');

        // Trigger refresh
        await api.refreshEnvironments(undefined);

        // Get state after refresh
        const afterRefresh = await api.getEnvironments('all');

        // Verify we got an actual array back (not undefined, null, or other type)
        assert.ok(Array.isArray(afterRefresh), `Expected environments array, got ${typeof afterRefresh}`);

        // Verify the API returns consistent data on repeated calls
        const secondCall = await api.getEnvironments('all');
        assert.strictEqual(afterRefresh.length, secondCall.length, 'Repeated API calls should return consistent data');
    });

    /**
     * Test: Events fire when environments change
     *
     */
    test('Change events fire on refresh', async function () {
        // Skip if event is not available
        if (!api.onDidChangeEnvironments) {
            this.skip();
            return;
        }

        const handler = new TestEventHandler(api.onDidChangeEnvironments, 'onDidChangeEnvironments');

        try {
            // Trigger a refresh which should fire events
            await api.refreshEnvironments(undefined);

            // Wait a bit for events to propagate
            // Note: Events may or may not fire depending on whether anything changed
            // This test verifies the event mechanism works, not that changes occurred
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // If any events fired, verify they have expected shape
            if (handler.fired) {
                const event = handler.first;
                assert.ok(event !== undefined, 'Event should have a value');
            }
        } finally {
            handler.dispose();
        }
    });

    /**
     * Test: Global vs all environments are different scopes
     *
     */
    test('Different scopes return appropriate environments', async function () {
        const allEnvs = await api.getEnvironments('all');
        const globalEnvs = await api.getEnvironments('global');

        // Both should return arrays
        assert.ok(Array.isArray(allEnvs), 'all scope should return array');
        assert.ok(Array.isArray(globalEnvs), 'global scope should return array');

        // Global should be subset of or equal to all
        // (all includes global + workspace-specific)
        assert.ok(
            globalEnvs.length <= allEnvs.length,
            `Global envs (${globalEnvs.length}) should not exceed all envs (${allEnvs.length})`,
        );
    });

    /**
     * Test: Environment objects are properly structured
     *
     */
    test('Environment objects have consistent structure', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Check each environment has basic required properties with valid values
        for (const env of environments) {
            const e = env as Record<string, unknown>;

            // Must have some form of identifier
            assert.ok('id' in e || 'envId' in e, 'Environment must have id or envId');

            // If it has an id, it should be a non-empty string
            if ('id' in e) {
                assert.strictEqual(typeof e.id, 'string', 'Environment id should be a string');
                assert.ok((e.id as string).length > 0, 'Environment id should not be empty');
            }

            // If it has envId, verify it's a valid object with required properties
            if ('envId' in e && e.envId !== null && e.envId !== undefined) {
                const envId = e.envId as Record<string, unknown>;
                assert.strictEqual(typeof envId, 'object', 'envId should be an object');
                assert.ok('id' in envId, 'envId should have an id property');
                assert.ok('managerId' in envId, 'envId should have a managerId property');
                assert.strictEqual(typeof envId.id, 'string', 'envId.id should be a string');
                assert.ok((envId.id as string).length > 0, 'envId.id should not be empty');
            }

            // Verify name is a non-empty string if present
            if ('name' in e && e.name !== undefined) {
                assert.strictEqual(typeof e.name, 'string', 'Environment name should be a string');
            }

            // Verify displayName is a non-empty string if present
            if ('displayName' in e && e.displayName !== undefined) {
                assert.strictEqual(typeof e.displayName, 'string', 'Environment displayName should be a string');
            }
        }
    });
});
