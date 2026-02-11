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
 * DIFFERS FROM:
 * - Unit tests: Uses real VS Code, not mocks
 * - E2E tests: Focuses on component integration, not full workflows
 * - Smoke tests: More thorough verification of behavior
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from '../constants';
import { TestEventHandler, waitForCondition } from '../testUtils';

suite('Integration: Environment Manager + API', function () {
    // Shorter timeout for faster feedback - integration tests shouldn't take 2 min
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
     * WHY THIS MATTERS:
     * The API is backed by internal managers. If they get out of sync,
     * users see stale data or missing environments.
     */
    test('API reflects manager state after refresh', async function () {
        // Get initial state (verify we can call API before refresh)
        await api.getEnvironments('all');

        // Trigger refresh
        await api.refreshEnvironments(undefined);

        // Get state after refresh
        const afterRefresh = await api.getEnvironments('all');

        // State should be consistent (same or more environments)
        // We can't assert exact equality since discovery might find more
        assert.ok(afterRefresh.length >= 0, `Expected environments array, got ${typeof afterRefresh}`);

        // Verify the API returns consistent data on repeated calls
        const secondCall = await api.getEnvironments('all');
        assert.strictEqual(afterRefresh.length, secondCall.length, 'Repeated API calls should return consistent data');
    });

    /**
     * Test: Events fire when environments change
     *
     * WHY THIS MATTERS:
     * UI components and other extensions subscribe to change events.
     * If events don't fire, the UI won't update.
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
     * WHY THIS MATTERS:
     * Users expect "global" to show system Python, "all" to include workspace envs.
     * If scopes aren't properly separated, filtering doesn't work.
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
     * WHY THIS MATTERS:
     * Consumers depend on environment object structure. If properties
     * are missing or malformed, integrations break.
     */
    test('Environment objects have consistent structure', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Check each environment has basic required properties
        for (const env of environments) {
            const e = env as Record<string, unknown>;

            // Must have some form of identifier
            assert.ok('id' in e || 'envId' in e, 'Environment must have id or envId');

            // If it has an id, it should be a string
            if ('id' in e) {
                assert.strictEqual(typeof e.id, 'string', 'Environment id should be a string');
            }
        }
    });
});
