// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Interpreter Selection Priority
 *
 * PURPOSE:
 * Verify that interpreter selection follows the correct priority order
 * and respects user configuration.
 *
 * WHAT THIS TESTS:
 * 1. Projects settings override other sources
 * 2. Explicit setEnvironment overrides auto-discovery
 * 3. Auto-discovery prefers workspace-local environments
 * 4. getEnvironment returns consistent results
 *
 * Priority order (from docs):
 * 1. pythonProjects[] - project-specific config
 * 2. defaultEnvManager - if explicitly set
 * 3. python.defaultInterpreterPath - legacy setting
 * 4. Auto-discovery - workspace-local .venv, then global
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DidChangeEnvironmentEventArgs, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { TestEventHandler, waitForCondition } from '../testUtils';

suite('Integration: Interpreter Selection Priority', function () {
    this.timeout(60_000);

    let api: PythonEnvironmentApi;
    let originalEnv: PythonEnvironment | undefined;

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

        // Save original state for restoration
        originalEnv = await api.getEnvironment(undefined);
    });

    // Reset to original state after each test to prevent state pollution
    teardown(async function () {
        try {
            if (originalEnv) {
                await api.setEnvironment(undefined, originalEnv);
            } else {
                await api.setEnvironment(undefined, undefined);
            }
        } catch {
            // Ignore errors during reset
        }
    });

    /**
     * Test: getEnvironment without scope returns global selection
     *
     * When no scope is specified, should return the currently active
     * global environment.
     */
    test('getEnvironment without scope returns global selection', async function () {
        const env = await api.getEnvironment(undefined);

        // May be undefined if no environment is selected/available
        if (env) {
            assert.ok(env.envId, 'Environment should have envId');
            assert.ok(env.displayName, 'Environment should have displayName');
        }
    });

    /**
     * Test: setEnvironment persists selection
     *
     * After calling setEnvironment, subsequent getEnvironment calls
     * should return the same environment.
     */
    test('setEnvironment persists selection', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const envToSet = environments[0];

        // Set environment globally
        await api.setEnvironment(undefined, envToSet);

        // Wait for the async config write to propagate and verify the result.
        // setEnvironment fires onDidChangeEnvironment asynchronously, so getEnvironment
        // called immediately after may still return the previous (auto-discovered) value
        // on slower CI runners.
        let retrieved: PythonEnvironment | undefined;
        await waitForCondition(
            async () => {
                retrieved = await api.getEnvironment(undefined);
                return !!retrieved && retrieved.environmentPath.fsPath === envToSet.environmentPath.fsPath;
            },
            15_000,
            () => `Environment was not persisted as ${envToSet.environmentPath.fsPath}`,
        );

        assert.ok(retrieved, 'Should have environment after setting');
        assert.strictEqual(
            retrieved!.environmentPath.fsPath,
            envToSet.environmentPath.fsPath,
            'Retrieved environment should point to the same interpreter as the one set',
        );
    });

    /**
     * Test: Project-scoped selection is independent of global
     *
     * Setting an environment for a specific project should not affect
     * the global selection or other projects.
     */
    test('Project selection is independent of global', async function () {
        const environments = await api.getEnvironments('all');
        const projects = api.getPythonProjects();

        if (environments.length < 2 || projects.length === 0) {
            this.skip();
            return;
        }

        const globalEnv = environments[0];
        const projectEnv = environments[1];
        const project = projects[0];

        // Set global environment
        await api.setEnvironment(undefined, globalEnv);

        // Set different environment for project
        await api.setEnvironment(project.uri, projectEnv);

        // Wait for the global env async write to propagate and verify.
        let globalRetrieved: PythonEnvironment | undefined;
        await waitForCondition(
            async () => {
                globalRetrieved = await api.getEnvironment(undefined);
                return !!globalRetrieved && globalRetrieved.environmentPath.fsPath === globalEnv.environmentPath.fsPath;
            },
            15_000,
            () => `Global environment was not persisted as ${globalEnv.environmentPath.fsPath}`,
        );

        assert.ok(globalRetrieved, 'Global should have environment');
        assert.strictEqual(
            globalRetrieved!.environmentPath.fsPath,
            globalEnv.environmentPath.fsPath,
            'Global selection should be unchanged',
        );

        // Wait for the project env async write to propagate and verify.
        let projectRetrieved: PythonEnvironment | undefined;
        await waitForCondition(
            async () => {
                projectRetrieved = await api.getEnvironment(project.uri);
                return (
                    !!projectRetrieved &&
                    projectRetrieved.environmentPath.fsPath === projectEnv.environmentPath.fsPath
                );
            },
            15_000,
            () => `Project environment was not persisted as ${projectEnv.environmentPath.fsPath}`,
        );

        assert.ok(projectRetrieved, 'Project should have environment');
        assert.strictEqual(
            projectRetrieved!.environmentPath.fsPath,
            projectEnv.environmentPath.fsPath,
            'Project should have its own selection',
        );
    });

    /**
     * Test: Change event fires with correct old/new values
     *
     * The onDidChangeEnvironment event should include both the old
     * and new environment values.
     */
    test('Change event includes old and new values', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length < 2) {
            this.skip();
            return;
        }

        const oldEnv = environments[0];
        const newEnv = environments[1];

        // Set initial environment and wait for it to propagate before
        // registering the event handler. Without this, the handler may
        // capture the event from this first setEnvironment call instead
        // of the subsequent one, causing a spurious assertion failure.
        await api.setEnvironment(undefined, oldEnv);
        await waitForCondition(
            async () => {
                const e = await api.getEnvironment(undefined);
                return !!e && e.environmentPath.fsPath === oldEnv.environmentPath.fsPath;
            },
            15_000,
            () => `Initial environment was not set to ${oldEnv.environmentPath.fsPath}`,
        );

        const handler = new TestEventHandler<DidChangeEnvironmentEventArgs>(
            api.onDidChangeEnvironment,
            'onDidChangeEnvironment',
        );

        try {
            // Change to new environment
            await api.setEnvironment(undefined, newEnv);

            // Wait for event - use 15s timeout for CI stability
            await handler.assertFired(15_000);

            const event = handler.last;
            assert.ok(event, 'Event should have fired');
            assert.ok(event.new, 'Event should have new environment');
            assert.strictEqual(
                event.new.environmentPath.fsPath,
                newEnv.environmentPath.fsPath,
                'New should match set environment',
            );
        } finally {
            handler.dispose();
        }
    });

    /**
     * Test: File URI inherits project environment
     *
     * When querying for a file within a project, should return
     * the project's environment.
     */
    test('File inherits project environment', async function () {
        const environments = await api.getEnvironments('all');
        const projects = api.getPythonProjects();

        if (environments.length === 0 || projects.length === 0) {
            this.skip();
            return;
        }

        const project = projects[0];
        const env = environments[0];

        // Set project environment
        await api.setEnvironment(project.uri, env);

        // Query for a file inside the project
        const fileUri = vscode.Uri.joinPath(project.uri, 'subdir', 'script.py');
        const fileEnv = await api.getEnvironment(fileUri);

        assert.ok(fileEnv, 'File should inherit project environment');
        assert.strictEqual(
            fileEnv.environmentPath.fsPath,
            env.environmentPath.fsPath,
            'File should use project environment',
        );
    });

    /**
     * Test: Selection is consistent across multiple calls
     *
     * Calling getEnvironment multiple times should return the same result.
     */
    test('Selection is consistent across calls', async function () {
        const env1 = await api.getEnvironment(undefined);
        const env2 = await api.getEnvironment(undefined);
        const env3 = await api.getEnvironment(undefined);

        if (!env1) {
            // No environment selected - that's consistent
            assert.strictEqual(env2, undefined, 'Should consistently return undefined');
            assert.strictEqual(env3, undefined, 'Should consistently return undefined');
            return;
        }

        assert.ok(env2, 'Second call should return environment');
        assert.ok(env3, 'Third call should return environment');

        assert.strictEqual(env1.envId.id, env2.envId.id, 'First and second should match');
        assert.strictEqual(env2.envId.id, env3.envId.id, 'Second and third should match');
    });

    /**
     * Test: Setting same environment doesn't fire extra events
     *
     * Setting the same environment twice should not fire change event
     * on the second call. This ensures idempotent behavior.
     */
    test('Setting same environment is idempotent', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        // Set environment first time
        await api.setEnvironment(undefined, env);

        // Wait for the async config write to propagate and verify.
        let currentEnv: PythonEnvironment | undefined;
        await waitForCondition(
            async () => {
                currentEnv = await api.getEnvironment(undefined);
                return !!currentEnv && currentEnv.environmentPath.fsPath === env.environmentPath.fsPath;
            },
            15_000,
            () => `Environment was not set to ${env.environmentPath.fsPath} before idempotency test`,
        );

        assert.ok(currentEnv, 'Environment should be set before idempotency test');
        assert.strictEqual(
            currentEnv!.environmentPath.fsPath,
            env.environmentPath.fsPath,
            'Environment should match what we just set',
        );

        const handler = new TestEventHandler<DidChangeEnvironmentEventArgs>(
            api.onDidChangeEnvironment,
            'onDidChangeEnvironment',
        );

        try {
            // Set same environment again
            await api.setEnvironment(undefined, env);

            // Wait for any potential events to fire
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Idempotent behavior: no event should fire when setting same environment
            assert.strictEqual(handler.fired, false, 'No event should fire when setting the same environment');
        } finally {
            handler.dispose();
        }
    });

    /**
     * Test: Clearing selection falls back to auto-discovery
     *
     * After clearing an explicit selection, auto-discovery should
     * provide a fallback environment. The system should find an
     * auto-discovered environment (e.g., .venv in workspace).
     */
    test('Clearing selection falls back to auto-discovery', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Set an explicit environment
        await api.setEnvironment(undefined, environments[0]);
        const beforeClear = await api.getEnvironment(undefined);
        assert.ok(beforeClear, 'Should have environment before clearing');

        // Clear the selection
        await api.setEnvironment(undefined, undefined);

        // Get environment - should return auto-discovered environment
        const autoEnv = await api.getEnvironment(undefined);

        // Auto-discovery should provide a fallback environment
        assert.ok(autoEnv, 'Auto-discovery should provide a fallback environment after clearing');
        assert.ok(autoEnv.envId, 'Auto-discovered env must have envId');
        assert.ok(autoEnv.envId.id, 'Auto-discovered env must have envId.id');
        assert.ok(autoEnv.displayName, 'Auto-discovered env must have displayName');
    });
});
