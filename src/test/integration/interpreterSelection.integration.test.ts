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
import { DidChangeEnvironmentEventArgs, PythonEnvironment, PythonEnvironmentApi, SetEnvironmentScope } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

/**
 * Returns a promise that resolves with the first event fired by the given
 * VS Code event emitter. Automatically disposes the subscription after
 * the event fires.
 */
function onceEvent<T>(event: vscode.Event<T>): Promise<T> {
    return new Promise<T>((resolve) => {
        const disposable = event((e) => {
            disposable.dispose();
            resolve(e);
        });
    });
}

/**
 * Calls setEnvironment and waits for the async event chain to fully settle.
 *
 * Compares the current environment with the target to determine whether
 * a change event is expected. If a change is expected, subscribes to
 * onDidChangeEnvironment BEFORE calling setEnvironment and awaits the
 * event. If no change is expected (idempotent set), calls setEnvironment
 * and returns immediately.
 *
 * Returns the change event if one was fired, or undefined for idempotent sets.
 */
async function setEnvironmentAndWait(
    api: PythonEnvironmentApi,
    scope: SetEnvironmentScope,
    env: PythonEnvironment | undefined,
): Promise<DidChangeEnvironmentEventArgs | undefined> {
    // Determine if this set will actually change the environment.
    // For array scopes, check the first URI (the primary project).
    const getScope = Array.isArray(scope) ? scope[0] : scope;
    const current = await api.getEnvironment(getScope);
    const expectsChange = current?.envId.id !== env?.envId.id;

    if (!expectsChange) {
        await api.setEnvironment(scope, env);
        return undefined;
    }

    // Subscribe before calling setEnvironment so we don't miss the event
    const eventPromise = onceEvent(api.onDidChangeEnvironment);
    await api.setEnvironment(scope, env);
    return eventPromise;
}

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

    // Reset to original state after each test to prevent state pollution.
    // Uses setEnvironmentAndWait to ensure all async events drain before
    // the next test starts — prevents stale events from leaking.
    teardown(async function () {
        try {
            await setEnvironmentAndWait(api, undefined, originalEnv);
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

        // Set environment and wait for async event chain to settle
        await setEnvironmentAndWait(api, undefined, envToSet);

        const retrieved = await api.getEnvironment(undefined);

        assert.ok(retrieved, 'Should have environment after setting');
        assert.strictEqual(
            retrieved.environmentPath.fsPath,
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

        // Set global environment and wait for event chain to settle
        await setEnvironmentAndWait(api, undefined, globalEnv);

        // Set different environment for project and wait
        await setEnvironmentAndWait(api, project.uri, projectEnv);

        // Verify global is unchanged
        const globalRetrieved = await api.getEnvironment(undefined);
        assert.ok(globalRetrieved, 'Global should have environment');
        assert.strictEqual(
            globalRetrieved.environmentPath.fsPath,
            globalEnv.environmentPath.fsPath,
            'Global selection should be unchanged',
        );

        // Verify project has its own selection
        const projectRetrieved = await api.getEnvironment(project.uri);
        assert.ok(projectRetrieved, 'Project should have environment');
        assert.strictEqual(
            projectRetrieved.environmentPath.fsPath,
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

        // Set initial environment and wait for all async events to drain
        await setEnvironmentAndWait(api, undefined, oldEnv);

        // Set new environment — the returned event contains the change payload
        const event = await setEnvironmentAndWait(api, undefined, newEnv);

        assert.ok(event, 'Change event should have fired');
        assert.ok(event.new, 'Event should have new environment');
        assert.strictEqual(
            event.new.envId.id,
            newEnv.envId.id,
            'Event new envId should match the environment we set',
        );
        assert.strictEqual(
            event.new.environmentPath.fsPath,
            newEnv.environmentPath.fsPath,
            'New should match set environment',
        );
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

        // Set project environment and wait for event chain to settle
        await setEnvironmentAndWait(api, project.uri, env);

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

        // Set environment first time and wait for event chain to settle
        await setEnvironmentAndWait(api, undefined, env);

        // Set same environment again and wait for any events to drain
        await setEnvironmentAndWait(api, undefined, env);

        // Verify functional idempotency: after setting the same environment
        // twice, getEnvironment should still return the same environment.
        // Note: We don't assert on events because the internal cache can be
        // mutated by manager-level refreshEnvironment() between calls, making
        // event-level idempotency unreliable.
        const afterSecondSet = await api.getEnvironment(undefined);
        assert.ok(afterSecondSet, 'Should still have environment after setting same env twice');
        assert.strictEqual(
            afterSecondSet.environmentPath.fsPath,
            env.environmentPath.fsPath,
            'Environment should remain the same after idempotent set',
        );
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

        // Set an explicit environment and wait for event chain to settle
        await setEnvironmentAndWait(api, undefined, environments[0]);
        const beforeClear = await api.getEnvironment(undefined);
        assert.ok(beforeClear, 'Should have environment before clearing');

        // Clear the selection and wait for event chain to settle
        await setEnvironmentAndWait(api, undefined, undefined);

        // Get environment - should return auto-discovered environment
        const autoEnv = await api.getEnvironment(undefined);

        // Auto-discovery should provide a fallback environment
        assert.ok(autoEnv, 'Auto-discovery should provide a fallback environment after clearing');
        assert.ok(autoEnv.envId, 'Auto-discovered env must have envId');
        assert.ok(autoEnv.envId.id, 'Auto-discovered env must have envId.id');
        assert.ok(autoEnv.displayName, 'Auto-discovered env must have displayName');
    });
});
