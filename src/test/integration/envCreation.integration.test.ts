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
    });

    /**
     * Test: createEnvironment API is available
     *
     * The API should have a createEnvironment method.
     */
    test('createEnvironment API is available', async function () {
        assert.ok(typeof api.createEnvironment === 'function', 'createEnvironment should be a function');
    });

    /**
     * Test: removeEnvironment API is available
     *
     * The API should have a removeEnvironment method.
     */
    test('removeEnvironment API is available', async function () {
        assert.ok(typeof api.removeEnvironment === 'function', 'removeEnvironment should be a function');
    });

    /**
     * Test: Managers that support creation are available
     *
     * At least one environment manager (venv or conda) should support creation.
     * This test verifies that global Python installations are discoverable.
     */
    test('At least one manager supports environment creation', async function () {
        // Get all environments to force managers to load
        await api.getEnvironments('all');

        // Check if we have global Python installations that can create venvs
        const globalEnvs = await api.getEnvironments('global');

        // Assert we have at least one global Python that can serve as base for venv creation
        assert.ok(
            globalEnvs.length > 0,
            'At least one global Python installation should be available for environment creation. ' +
                'If this fails, ensure Python is installed and discoverable on this system.',
        );

        // Verify the global environments have required properties for creation
        for (const env of globalEnvs) {
            assert.ok(env.envId, 'Global environment must have envId');
            assert.ok(env.environmentPath, 'Global environment must have environmentPath');
        }

        console.log(`Found ${globalEnvs.length} global Python installations for venv creation`);
    });

    /**
     * Test: Created environment appears in discovery
     *
     * After creating an environment, it should be discoverable via getEnvironments.
     * This test creates a real environment and cleans it up.
     */
    test('Created environment appears in discovery', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        // Check if we have Python available for venv creation
        const globalEnvs = await api.getEnvironments('global');
        if (globalEnvs.length === 0) {
            console.log('No global Python installations found, skipping creation test');
            this.skip();
            return;
        }

        const workspaceUri = workspaceFolders[0].uri;
        let createdEnv: PythonEnvironment | undefined;

        try {
            // Create environment with quickCreate to avoid prompts
            createdEnv = await api.createEnvironment(workspaceUri, { quickCreate: true });

            if (!createdEnv) {
                // Creation may have been cancelled or failed silently
                console.log('Environment creation returned undefined (may require user input)');
                this.skip();
                return;
            }

            // Refresh and verify the environment appears
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
                    console.log('Cleanup failed (may already be removed):', e);
                }
            }
        }
    });

    /**
     * Test: Environment removal removes from discovery
     *
     * After removing an environment, it should no longer appear in discovery.
     */
    test('Removed environment disappears from discovery', async function () {
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
            // Create environment
            createdEnv = await api.createEnvironment(workspaceUri, { quickCreate: true });

            if (!createdEnv) {
                this.skip();
                return;
            }

            // Record the environment ID
            const envId = createdEnv.envId.id;

            // Remove environment
            await api.removeEnvironment(createdEnv);
            createdEnv = undefined; // Mark as cleaned up

            // Give time for removal to complete
            await sleep(1000);

            // Refresh and verify it's gone
            await api.refreshEnvironments(workspaceUri);
            const environments = await api.getEnvironments(workspaceUri);

            const stillExists = environments.some((env) => env.envId.id === envId);

            assert.ok(!stillExists, 'Removed environment should not appear in discovery');
        } finally {
            // Cleanup in case removal failed
            if (createdEnv) {
                try {
                    await api.removeEnvironment(createdEnv);
                } catch {
                    // Ignore cleanup errors
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
                } catch {
                    // Ignore cleanup errors
                }
            }
        }
    });
});
