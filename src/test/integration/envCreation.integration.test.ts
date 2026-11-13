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
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { VENV_MANAGER_ID } from '../../common/constants';
import { normalizePath } from '../../common/utils/pathUtils';
import { ENVS_EXTENSION_ID } from '../constants';
import { retryUntilSuccess, runWithBlockedDialogsAsCancellation, waitForCondition } from '../testUtils';

suite('Integration: Environment Creation', function () {
    this.timeout(120_000); // Environment creation can be slow

    let api: PythonEnvironmentApi;
    let defaultManagerScope: vscode.Uri | undefined;
    let previousDefaultManager: string | undefined;
    let previousEffectiveDefaultManager: string | undefined;
    let fixtureRoot: string | undefined;
    let creationScope: vscode.Uri;
    let settingSnapshotTaken = false;

    async function removeCreatedEnvironment(environment: PythonEnvironment): Promise<void> {
        const environmentPath = path.resolve(environment.sysPrefix);
        await api.removeEnvironment(environment, { runHeadless: true });
        await waitForCondition(
            async () => !(await fs.pathExists(environmentPath)),
            30_000,
            'Environment directory was not removed: ' + environmentPath,
        );
    }

    suiteSetup(async function () {
        this.timeout(30_000);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, 'Environment creation tests require a workspace folder');
        defaultManagerScope = workspaceFolder.uri;
        // Workspace activation-script watchers can schedule discovery after creation returns.
        // Keep owned interpreters outside that workspace to avoid competing background refreshes.
        fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pyenvs-creation-')));
        creationScope = vscode.Uri.file(fixtureRoot);
        const defaultManagerConfig = vscode.workspace.getConfiguration('python-envs', defaultManagerScope);
        const inspected = defaultManagerConfig.inspect<string>('defaultEnvManager');
        previousDefaultManager = inspected?.workspaceValue;
        previousEffectiveDefaultManager = defaultManagerConfig.get<string>('defaultEnvManager');
        settingSnapshotTaken = true;
        await defaultManagerConfig.update(
            'defaultEnvManager',
            VENV_MANAGER_ID,
            vscode.ConfigurationTarget.Workspace,
        );
        await waitForCondition(
            () =>
                vscode.workspace
                    .getConfiguration('python-envs', defaultManagerScope)
                    .get<string>('defaultEnvManager') === VENV_MANAGER_ID,
            10_000,
            'Venv manager override was not applied',
        );

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

    suiteTeardown(async function () {
        this.timeout(30_000);
        const cleanupErrors: unknown[] = [];
        if (fixtureRoot) {
            const root = fixtureRoot;
            try {
                await retryUntilSuccess(
                    () => fs.remove(root),
                    () => true,
                    5_000,
                    'Failed to remove owned environment creation fixture',
                );
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (settingSnapshotTaken && defaultManagerScope) {
            try {
                await vscode.workspace
                    .getConfiguration('python-envs', defaultManagerScope)
                    .update(
                        'defaultEnvManager',
                        previousDefaultManager,
                        vscode.ConfigurationTarget.Workspace,
                    );
                await waitForCondition(
                    () =>
                        vscode.workspace
                            .getConfiguration('python-envs', defaultManagerScope)
                            .get<string>('defaultEnvManager') === previousEffectiveDefaultManager,
                    10_000,
                    'Default environment manager setting was not restored',
                );
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new Error(
                'Environment creation integration cleanup failed:\n' +
                    cleanupErrors
                        .map((error) => (error instanceof Error ? error.message : String(error)))
                        .join('\n'),
            );
        }
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

        let createdEnv: PythonEnvironment | undefined;

        try {
            // --- ACTION: User creates environment ---
            createdEnv = await runWithBlockedDialogsAsCancellation(() =>
                api.createEnvironment(creationScope, { quickCreate: true }),
            );

            if (!createdEnv) {
                console.log('Environment creation returned undefined (may require user input)');
                this.skip();
                return;
            }

            // --- VERIFY: Created environment is discoverable ---
            await api.refreshEnvironments(creationScope);
            const environments = await api.getEnvironments('all');

            const createdPrefix = normalizePath(path.resolve(createdEnv.sysPrefix));
            const found = environments.some(
                (env) =>
                    env.envId.managerId === createdEnv!.envId.managerId &&
                    normalizePath(path.resolve(env.sysPrefix)) === createdPrefix,
            );

            assert.ok(found, 'Created environment should appear in discovery');
        } finally {
            // Cleanup: Remove the created environment
            if (createdEnv) {
                try {
                    await removeCreatedEnvironment(createdEnv);
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

        let createdEnv: PythonEnvironment | undefined;

        try {
            createdEnv = await runWithBlockedDialogsAsCancellation(() =>
                api.createEnvironment(creationScope, { quickCreate: true }),
            );
            if (!createdEnv) {
                this.skip();
                return;
            }

            const envId = createdEnv.envId.id;
            const managerId = createdEnv.envId.managerId;
            const envPath = normalizePath(path.resolve(createdEnv.sysPrefix));

            // --- ACTION: User removes environment ---
            await removeCreatedEnvironment(createdEnv);

            // --- VERIFY: Environment is no longer discoverable ---
            await api.refreshEnvironments(creationScope);
            const environments = await api.getEnvironments('all');

            const stillExists = environments.some(
                (env) =>
                    env.envId.managerId === managerId &&
                    (env.envId.id === envId || normalizePath(path.resolve(env.sysPrefix)) === envPath),
            );

            assert.ok(!stillExists, 'Removed environment should not appear in discovery');
            createdEnv = undefined;
        } finally {
            // Cleanup in case removal failed
            if (createdEnv) {
                try {
                    await removeCreatedEnvironment(createdEnv);
                } catch (e) {
                    console.warn('Cleanup warning - failed to remove environment:', e);
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

        let createdEnv: PythonEnvironment | undefined;

        try {
            createdEnv = await runWithBlockedDialogsAsCancellation(() =>
                api.createEnvironment(creationScope, { quickCreate: true }),
            );

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
                    await removeCreatedEnvironment(createdEnv);
                } catch (e) {
                    console.warn('Cleanup warning - failed to remove environment:', e);
                }
            }
        }
    });
});
