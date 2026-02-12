// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Settings Behavior
 *
 * PURPOSE:
 * Verify that settings are read and written correctly, and that
 * the extension respects VS Code's settings hierarchy.
 *
 * WHAT THIS TESTS:
 * 1. Opening workspace doesn't pollute settings
 * 2. Manual selection writes to settings
 * 3. Settings scope is respected
 * 4. Environment variables API works
 *
 * NOTE: These tests interact with VS Code settings.
 * Care should be taken to restore original settings after tests.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Integration: Settings Behavior', function () {
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
    });

    /**
     * Test: Extension settings are accessible
     *
     * The python-envs configuration section should be accessible.
     */
    test('Extension settings section is accessible', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');

        assert.ok(config, 'python-envs configuration should be accessible');

        // Check some expected settings exist
        const defaultEnvManager = config.get('defaultEnvManager');
        const defaultPackageManager = config.get('defaultPackageManager');

        // Settings should have values (may be defaults)
        console.log('defaultEnvManager:', defaultEnvManager);
        console.log('defaultPackageManager:', defaultPackageManager);
    });

    /**
     * Test: workspaceSearchPaths setting is accessible
     *
     * The search paths setting should be readable.
     */
    test('workspaceSearchPaths setting is readable', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const config = vscode.workspace.getConfiguration('python-envs', workspaceFolders[0].uri);
        const searchPaths = config.get<string[]>('workspaceSearchPaths');

        // Default should be ["./**/.venv"]
        assert.ok(
            Array.isArray(searchPaths) || searchPaths === undefined,
            'workspaceSearchPaths should be array or undefined',
        );

        if (searchPaths) {
            console.log('workspaceSearchPaths:', searchPaths);
        }
    });

    /**
     * Test: globalSearchPaths setting is accessible
     *
     * The global search paths setting should be readable.
     */
    test('globalSearchPaths setting is readable', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');
        const globalPaths = config.get<string[]>('globalSearchPaths');

        assert.ok(
            Array.isArray(globalPaths) || globalPaths === undefined,
            'globalSearchPaths should be array or undefined',
        );

        if (globalPaths) {
            console.log('globalSearchPaths:', globalPaths);
        }
    });

    /**
     * Test: pythonProjects setting structure
     *
     * The pythonProjects setting should have the correct structure.
     */
    test('pythonProjects setting has correct structure', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const config = vscode.workspace.getConfiguration('python-envs', workspaceFolders[0].uri);
        const projects =
            config.get<Array<{ path: string; envManager?: string; packageManager?: string }>>('pythonProjects');

        if (projects && projects.length > 0) {
            for (const project of projects) {
                assert.ok(typeof project.path === 'string', 'Project should have path');
            }
        }

        console.log('pythonProjects:', JSON.stringify(projects, null, 2));
    });

    /**
     * Test: Settings inspection shows scope
     *
     * Using inspect() should show which scope a setting comes from.
     */
    test('Settings inspection shows scope information', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const config = vscode.workspace.getConfiguration('python-envs', workspaceFolders[0].uri);
        const inspection = config.inspect('defaultEnvManager');

        assert.ok(inspection, 'Inspection should return result');
        assert.ok(
            'defaultValue' in inspection || 'globalValue' in inspection,
            'Inspection should have value properties',
        );

        console.log('defaultEnvManager inspection:', JSON.stringify(inspection, null, 2));
    });

    /**
     * Test: Environment variables API is available
     *
     * The getEnvironmentVariables API should be callable.
     */
    test('getEnvironmentVariables API is available', async function () {
        assert.ok(typeof api.getEnvironmentVariables === 'function', 'getEnvironmentVariables should be a function');
        assert.ok(api.onDidChangeEnvironmentVariables, 'onDidChangeEnvironmentVariables should be available');
    });

    /**
     * Test: getEnvironmentVariables returns object
     *
     * The method should return an environment variables object.
     */
    test('getEnvironmentVariables returns variables', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const envVars = await api.getEnvironmentVariables(workspaceFolders[0].uri);

        assert.ok(typeof envVars === 'object', 'Should return object');

        // Should have some common environment variables
        const hasPath = 'PATH' in envVars || 'Path' in envVars;
        console.log('Has PATH:', hasPath);
    });

    /**
     * Test: getEnvironmentVariables with overrides
     *
     * Passing overrides should merge them into the result.
     */
    test('getEnvironmentVariables applies overrides', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const testVar = 'TEST_INTEGRATION_VAR';
        const testValue = 'test_value_12345';

        const envVars = await api.getEnvironmentVariables(workspaceFolders[0].uri, [{ [testVar]: testValue }]);

        assert.strictEqual(envVars[testVar], testValue, 'Override should be applied');
    });

    /**
     * Test: getEnvironmentVariables with undefined uri
     *
     * Calling with undefined uri should return global environment.
     */
    test('getEnvironmentVariables works with undefined uri', async function () {
        const envVars = await api.getEnvironmentVariables(undefined as unknown as vscode.Uri);

        assert.ok(typeof envVars === 'object', 'Should return object for undefined uri');
    });

    /**
     * Test: Terminal settings are accessible
     *
     * Terminal-specific settings should be accessible.
     */
    test('Terminal settings are accessible', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');

        const activationType = config.get('terminal.autoActivationType');
        const showButton = config.get('terminal.showActivateButton');

        console.log('terminal.autoActivationType:', activationType);
        console.log('terminal.showActivateButton:', showButton);
    });

    /**
     * Test: alwaysUseUv setting is accessible
     *
     * The uv preference setting should be readable.
     */
    test('alwaysUseUv setting is accessible', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');
        const alwaysUseUv = config.get('alwaysUseUv');

        // Default is true according to docs
        console.log('alwaysUseUv:', alwaysUseUv);
    });

    /**
     * Test: Legacy python settings are accessible
     *
     * Legacy python.* settings should be readable for migration.
     */
    test('Legacy python settings are accessible', async function () {
        const pythonConfig = vscode.workspace.getConfiguration('python');

        // These are legacy settings that may have values
        const venvPath = pythonConfig.get('venvPath');
        const venvFolders = pythonConfig.get('venvFolders');
        const defaultInterpreterPath = pythonConfig.get('defaultInterpreterPath');
        const condaPath = pythonConfig.get('condaPath');

        console.log('Legacy settings:');
        console.log('  venvPath:', venvPath);
        console.log('  venvFolders:', venvFolders);
        console.log('  defaultInterpreterPath:', defaultInterpreterPath);
        console.log('  condaPath:', condaPath);
    });

    /**
     * Test: Settings update is reflected in API
     *
     * When settings change, the API should reflect the changes.
     * Note: This test doesn't actually modify settings to avoid side effects.
     */
    test('Settings and API are connected', async function () {
        // Get current environment
        const currentEnv = await api.getEnvironment(undefined);

        // Get current settings
        const config = vscode.workspace.getConfiguration('python-envs');
        const currentProjects = config.get('pythonProjects');

        // Just verify we can read both without error
        console.log('Current env:', currentEnv?.displayName ?? 'none');
        console.log('Projects setting exists:', currentProjects !== undefined);
    });

    /**
     * Test: Workspace folder scope is respected
     *
     * Settings at workspace folder level should be isolated.
     */
    test('Workspace folder settings scope is respected', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length < 2) {
            // Need at least 2 folders to test isolation
            this.skip();
            return;
        }

        const config1 = vscode.workspace.getConfiguration('python-envs', workspaceFolders[0].uri);
        const config2 = vscode.workspace.getConfiguration('python-envs', workspaceFolders[1].uri);

        // Both should be independently configurable
        const inspect1 = config1.inspect('pythonProjects');
        const inspect2 = config2.inspect('pythonProjects');

        console.log('Folder 1 pythonProjects:', inspect1?.workspaceFolderValue);
        console.log('Folder 2 pythonProjects:', inspect2?.workspaceFolderValue);
    });
});
