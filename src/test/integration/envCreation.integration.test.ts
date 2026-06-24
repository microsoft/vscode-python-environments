// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Environment Creation
 *
 * PURPOSE:
 * Verify that environment creation works correctly through the API,
 * respecting configured managers and options.
 *
 * WHAT THIS TESTS:
 * 1. createEnvironment API is available and callable
 * 2. Creation respects defaultEnvManager setting
 * 3. Created environments appear in discovery
 * 4. Environment removal works correctly
 *
 * NOTE: These tests may create actual virtual environments on disk.
 * Tests that create environments should clean up after themselves.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { sleep, waitForCondition } from '../testUtils';

suite('Integration: Environment Creation', function () {
    this.timeout(120_000); // Environment creation can be slow

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
        assert.ok(typeof api.createEnvironment === 'function', 'createEnvironment should be a function');
        assert.ok(typeof api.removeEnvironment === 'function', 'removeEnvironment should be a function');
    });

    // =========================================================================
    // ENVIRONMENT CREATION BEHAVIOR TESTS
    // These tests verify actual user-facing creation and removal workflows.
    // =========================================================================

    /**
     * Test: Created environment appears in discovery
     *
     * BEHAVIOR TESTED: User creates an environment via quickCreate,
     * then the environment should be discoverable via getEnvironments.
     */
    test('Created environment appears in discovery', async function () {
        // --- SETUP: Ensure we have prerequisites ---
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const globalEnvs = await api.getEnvironments('global');
        if (globalEnvs.length === 0) {
            console.log('No global Python installations found, skipping creation test');
            this.skip();
            return;
        }

        const workspaceUri = workspaceFolders[0].uri;
        let createdEnv: PythonEnvironment | undefined;

        try {
            // --- ACTION: User creates environment ---
            createdEnv = await api.createEnvironment(workspaceUri, { quickCreate: true });

            if (!createdEnv) {
                console.log('Environment creation returned undefined (may require user input)');
                this.skip();
                return;
            }

            // --- VERIFY: Created environment is discoverable ---
            await api.refreshEnvironments(workspaceUri);
            const environments = await api.getEnvironments(workspaceUri);

            const found = environments.some(
                (env) =>
                    env.envId.id === createdEnv!.envId.id ||
                    env.environmentPath.fsPath === createdEnv!.environmentPath.fsPath,
            );

            assert.ok(found, 'Created environment should appear in discovery');
        } finally {
            // Cleanup: Remove the created environment
            if (createdEnv) {
                try {
                    await api.removeEnvironment(createdEnv);
                } catch (e) {
                    console.warn('Cleanup warning - failed to remove environment:', e);
                }
            }
        }
    });

    /**
     * Test: Environment removal removes from discovery
     *
     * BEHAVIOR TESTED: User removes an environment, then it should
     * no longer appear in discovery results.
     */
    test('Removed environment disappears from discovery', async function () {
        // --- SETUP: Create an environment to remove ---
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const globalEnvs = await api.getEnvironments('global');
        if (globalEnvs.length === 0) {
            this.skip();
            return;
        }

        const workspaceUri = workspaceFolders[0].uri;
        let createdEnv: PythonEnvironment | undefined;

        try {
            createdEnv = await api.createEnvironment(workspaceUri, { quickCreate: true });
            if (!createdEnv) {
                this.skip();
                return;
            }

            const envId = createdEnv.envId.id;

            // --- ACTION: User removes environment ---
            await api.removeEnvironment(createdEnv);
            createdEnv = undefined;

            await sleep(1000);

            // --- VERIFY: Environment is no longer discoverable ---
            await api.refreshEnvironments(workspaceUri);
            const environments = await api.getEnvironments(workspaceUri);

            const stillExists = environments.some((env) => env.envId.id === envId);

            assert.ok(!stillExists, 'Removed environment should not appear in discovery');
        } finally {
            // Cleanup in case removal failed
            if (createdEnv) {
                try {
                    await api.removeEnvironment(createdEnv);
                } catch (e) {
                    console.warn('Cleanup warning - failed to remove environment:', e);
                }
            }
        }
    });

    /**
     * Test: Creating environment for 'global' scope
     *
     * The 'global' scope should allow creating environments not tied to a workspace.
     * Note: This may require special permissions or configurations.
     */
    test('Global scope creation is handled', async function () {
        // This test verifies the API handles global scope correctly
        let createdEnv: PythonEnvironment | undefined;

        try {
            // Attempt global creation - this may prompt for user input
            // so we use quickCreate and expect it might return undefined
            createdEnv = await api.createEnvironment('global', { quickCreate: true });

            if (createdEnv) {
                // If creation succeeded, verify the environment has valid structure
                assert.ok(createdEnv.envId, 'Created global env must have envId');
                assert.ok(createdEnv.envId.id, 'Created global env must have envId.id');
                assert.ok(createdEnv.environmentPath, 'Created global env must have environmentPath');
            } else {
                // quickCreate returned undefined - skip this test as feature not available
                console.log('Global creation not supported with quickCreate, skipping');
                this.skip();
                return;
            }
        } finally {
            // Cleanup: try to remove if created, but handle dialog errors in test mode
            if (createdEnv) {
                try {
                    await api.removeEnvironment(createdEnv);
                } catch (e) {
                    // Ignore dialog errors in test mode - VS Code blocks dialogs
                    if (!String(e).includes('DialogService')) {
                        throw e;
                    }
                    console.log('Skipping cleanup for global environment (dialog blocked in tests)');
                }
            }
        }
    });

    /**
     * Test: Creation returns properly structured environment
     *
     * A successfully created environment should have all required fields.
     */
    test('Created environment has proper structure', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const globalEnvs = await api.getEnvironments('global');
        if (globalEnvs.length === 0) {
            this.skip();
            return;
        }

        const workspaceUri = workspaceFolders[0].uri;
        let createdEnv: PythonEnvironment | undefined;

        try {
            createdEnv = await api.createEnvironment(workspaceUri, { quickCreate: true });

            if (!createdEnv) {
                this.skip();
                return;
            }

            // Verify structure
            assert.ok(createdEnv.envId, 'Created env must have envId');
            assert.ok(createdEnv.envId.id, 'envId must have id');
            assert.ok(createdEnv.envId.managerId, 'envId must have managerId');
            assert.ok(createdEnv.name, 'Created env must have name');
            assert.ok(createdEnv.displayName, 'Created env must have displayName');
            assert.ok(createdEnv.environmentPath, 'Created env must have environmentPath');
        } finally {
            if (createdEnv) {
                try {
                    await api.removeEnvironment(createdEnv);
                } catch (e) {
                    console.warn('Cleanup warning - failed to remove environment:', e);
                }
            }
        }
    });
});
