// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Smoke Test: Registration Checks
 *
 * PURPOSE:
 * Comprehensive verification that all commands, API methods, and events
 * are properly registered and accessible. These are fast, deterministic
 * checks with no side effects.
 *
 * WHAT THIS TESTS:
 * 1. All extension commands are registered with VS Code
 * 2. API surface is correct (methods exist and are functions)
 * 3. Event emitters are properly exposed
 * 4. Environment managers are registered
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID, MAX_EXTENSION_ACTIVATION_TIME } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Smoke: Registration Checks', function () {
    this.timeout(MAX_EXTENSION_ACTIVATION_TIME);

    let api: PythonEnvironmentApi;

    suiteSetup(async function () {
        const extension = vscode.extensions.getExtension<PythonEnvironmentApi>(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 30_000, 'Extension did not activate');
        }

        api = extension.exports;
        assert.ok(api, 'API not exported');
    });

    // =========================================================================
    // COMMANDS - All extension commands must be registered
    // =========================================================================

    test('All extension commands are registered', async function () {
        const allCommands = await vscode.commands.getCommands(true);

        // Complete list of commands from package.json
        const requiredCommands = [
            // Environment management
            'python-envs.create',
            'python-envs.createAny',
            'python-envs.set',
            'python-envs.setEnv',
            'python-envs.setEnvSelected',
            'python-envs.remove',
            'python-envs.setEnvManager',
            'python-envs.setPkgManager',
            'python-envs.refreshAllManagers',
            'python-envs.clearCache',
            'python-envs.searchSettings',

            // Package management
            'python-envs.packages',
            'python-envs.refreshPackages',
            'python-envs.uninstallPackage',

            // Projects
            'python-envs.addPythonProject',
            'python-envs.addPythonProjectGivenResource',
            'python-envs.removePythonProject',
            'python-envs.createNewProjectFromTemplate',
            'python-envs.revealProjectInExplorer',

            // Terminal
            'python-envs.createTerminal',
            'python-envs.runInTerminal',
            'python-envs.runAsTask',
            'python-envs.terminal.activate',
            'python-envs.terminal.deactivate',
            'python-envs.terminal.revertStartupScriptChanges',

            // Utility
            'python-envs.copyEnvPath',
            'python-envs.copyEnvPathCopied',
            'python-envs.copyProjectPath',
            'python-envs.copyProjectPathCopied',
            'python-envs.revealEnvInManagerView',
            'python-envs.reportIssue',
            'python-envs.runPetInTerminal',
        ];

        const missingCommands: string[] = [];

        for (const cmd of requiredCommands) {
            if (!allCommands.includes(cmd)) {
                missingCommands.push(cmd);
            }
        }

        assert.strictEqual(
            missingCommands.length,
            0,
            `Missing commands:\n${missingCommands.map((c) => `  - ${c}`).join('\n')}\n\n` +
                'Check that each command is defined in package.json and registered in the extension.',
        );
    });

    // =========================================================================
    // API METHODS - All API methods must exist and be functions
    // =========================================================================

    test('Environment management API methods exist', function () {
        // PythonEnvironmentsApi
        assert.strictEqual(typeof api.refreshEnvironments, 'function', 'refreshEnvironments should be a function');
        assert.strictEqual(typeof api.getEnvironments, 'function', 'getEnvironments should be a function');
        assert.strictEqual(typeof api.resolveEnvironment, 'function', 'resolveEnvironment should be a function');

        // PythonEnvironmentManagementApi
        assert.strictEqual(typeof api.createEnvironment, 'function', 'createEnvironment should be a function');
        assert.strictEqual(typeof api.removeEnvironment, 'function', 'removeEnvironment should be a function');

        // PythonProjectEnvironmentApi
        assert.strictEqual(typeof api.setEnvironment, 'function', 'setEnvironment should be a function');
        assert.strictEqual(typeof api.getEnvironment, 'function', 'getEnvironment should be a function');

        // PythonEnvironmentItemApi
        assert.strictEqual(
            typeof api.createPythonEnvironmentItem,
            'function',
            'createPythonEnvironmentItem should be a function',
        );

        // PythonEnvironmentManagerRegistrationApi
        assert.strictEqual(
            typeof api.registerEnvironmentManager,
            'function',
            'registerEnvironmentManager should be a function',
        );
    });

    test('Package management API methods exist', function () {
        // PythonPackageGetterApi
        assert.strictEqual(typeof api.refreshPackages, 'function', 'refreshPackages should be a function');
        assert.strictEqual(typeof api.getPackages, 'function', 'getPackages should be a function');

        // PythonPackageManagementApi
        assert.strictEqual(typeof api.managePackages, 'function', 'managePackages should be a function');

        // PythonPackageItemApi
        assert.strictEqual(typeof api.createPackageItem, 'function', 'createPackageItem should be a function');

        // PythonPackageManagerRegistrationApi
        assert.strictEqual(
            typeof api.registerPackageManager,
            'function',
            'registerPackageManager should be a function',
        );
    });

    test('Project API methods exist', function () {
        // PythonProjectGetterApi
        assert.strictEqual(typeof api.getPythonProjects, 'function', 'getPythonProjects should be a function');
        assert.strictEqual(typeof api.getPythonProject, 'function', 'getPythonProject should be a function');

        // PythonProjectModifyApi
        assert.strictEqual(typeof api.addPythonProject, 'function', 'addPythonProject should be a function');
        assert.strictEqual(typeof api.removePythonProject, 'function', 'removePythonProject should be a function');

        // PythonProjectCreationApi
        assert.strictEqual(
            typeof api.registerPythonProjectCreator,
            'function',
            'registerPythonProjectCreator should be a function',
        );
    });

    test('Execution API methods exist', function () {
        // PythonTerminalCreateApi
        assert.strictEqual(typeof api.createTerminal, 'function', 'createTerminal should be a function');

        // PythonTerminalRunApi
        assert.strictEqual(typeof api.runInTerminal, 'function', 'runInTerminal should be a function');
        assert.strictEqual(
            typeof api.runInDedicatedTerminal,
            'function',
            'runInDedicatedTerminal should be a function',
        );

        // PythonTaskRunApi
        assert.strictEqual(typeof api.runAsTask, 'function', 'runAsTask should be a function');

        // PythonBackgroundRunApi
        assert.strictEqual(typeof api.runInBackground, 'function', 'runInBackground should be a function');
    });

    test('Environment variables API methods exist', function () {
        assert.strictEqual(
            typeof api.getEnvironmentVariables,
            'function',
            'getEnvironmentVariables should be a function',
        );
    });

    // =========================================================================
    // API EVENTS - All events must be defined
    // =========================================================================

    test('Environment events are defined', function () {
        // Check events exist and have the expected shape
        assert.ok(api.onDidChangeEnvironments, 'onDidChangeEnvironments should be defined');
        assert.ok(api.onDidChangeEnvironment, 'onDidChangeEnvironment should be defined');

        // Events should be subscribable (have a function signature)
        assert.strictEqual(
            typeof api.onDidChangeEnvironments,
            'function',
            'onDidChangeEnvironments should be subscribable',
        );
        assert.strictEqual(
            typeof api.onDidChangeEnvironment,
            'function',
            'onDidChangeEnvironment should be subscribable',
        );
    });

    test('Package events are defined', function () {
        assert.ok(api.onDidChangePackages, 'onDidChangePackages should be defined');
        assert.strictEqual(typeof api.onDidChangePackages, 'function', 'onDidChangePackages should be subscribable');
    });

    test('Project events are defined', function () {
        assert.ok(api.onDidChangePythonProjects, 'onDidChangePythonProjects should be defined');
        assert.strictEqual(
            typeof api.onDidChangePythonProjects,
            'function',
            'onDidChangePythonProjects should be subscribable',
        );
    });

    test('Environment variables events are defined', function () {
        assert.ok(api.onDidChangeEnvironmentVariables, 'onDidChangeEnvironmentVariables should be defined');
        assert.strictEqual(
            typeof api.onDidChangeEnvironmentVariables,
            'function',
            'onDidChangeEnvironmentVariables should be subscribable',
        );
    });

    // =========================================================================
    // ENVIRONMENT MANAGERS - Built-in managers should be registered
    // =========================================================================

    test('Built-in environment managers are registered', async function () {
        // Get all environments to verify managers are working
        const environments = await api.getEnvironments('all');

        // We can't guarantee environments exist, but the call should succeed
        assert.ok(Array.isArray(environments), 'getEnvironments should return an array');

        // If environments exist, verify they have the expected shape
        if (environments.length > 0) {
            const env = environments[0];
            assert.ok(env.envId, 'Environment should have envId');
            assert.ok(env.envId.id, 'envId should have id');
            assert.ok(env.envId.managerId, 'envId should have managerId');
            assert.ok(env.name, 'Environment should have name');
            assert.ok(env.displayName, 'Environment should have displayName');
        }
    });

    // =========================================================================
    // PROJECTS - Project API should be callable
    // =========================================================================

    test('getPythonProjects is callable', function () {
        // Should not throw, even if no projects are configured
        const projects = api.getPythonProjects();
        assert.ok(Array.isArray(projects), 'getPythonProjects should return an array');
    });
});
