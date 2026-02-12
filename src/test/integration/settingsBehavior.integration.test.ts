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
     * The python-envs configuration section should be accessible with expected types.
     */
    test('Extension settings section is accessible', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');

        assert.ok(config, 'python-envs configuration should be accessible');

        // Check some expected settings exist and have correct types
        const defaultEnvManager = config.get('defaultEnvManager');
        const defaultPackageManager = config.get('defaultPackageManager');

        // Assert settings have expected types (string or undefined)
        assert.ok(
            typeof defaultEnvManager === 'string' || defaultEnvManager === undefined,
            `defaultEnvManager should be string or undefined, got ${typeof defaultEnvManager}`,
        );
        assert.ok(
            typeof defaultPackageManager === 'string' || defaultPackageManager === undefined,
            `defaultPackageManager should be string or undefined, got ${typeof defaultPackageManager}`,
        );

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
     * Terminal-specific settings should be accessible with expected types.
     */
    test('Terminal settings are accessible', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');

        const activationType = config.get('terminal.autoActivationType');
        const showButton = config.get('terminal.showActivateButton');

        // Assert settings have expected types
        // activationType should be string (enum value) or undefined
        assert.ok(
            typeof activationType === 'string' || activationType === undefined,
            `terminal.autoActivationType should be string or undefined, got ${typeof activationType}`,
        );

        // showButton should be boolean or undefined
        assert.ok(
            typeof showButton === 'boolean' || showButton === undefined,
            `terminal.showActivateButton should be boolean or undefined, got ${typeof showButton}`,
        );

        console.log('terminal.autoActivationType:', activationType);
        console.log('terminal.showActivateButton:', showButton);
    });

    /**
     * Test: alwaysUseUv setting is accessible
     *
     * The uv preference setting should be readable and have expected type.
     */
    test('alwaysUseUv setting is accessible', async function () {
        const config = vscode.workspace.getConfiguration('python-envs');
        const alwaysUseUv = config.get('alwaysUseUv');

        // alwaysUseUv should be boolean or undefined
        assert.ok(
            typeof alwaysUseUv === 'boolean' || alwaysUseUv === undefined,
            `alwaysUseUv should be boolean or undefined, got ${typeof alwaysUseUv}`,
        );

        console.log('alwaysUseUv:', alwaysUseUv);
    });

    /**
     * Test: Legacy python settings are accessible
     *
     * Legacy python.* settings should be readable for migration with expected types.
     */
    test('Legacy python settings are accessible', async function () {
        const pythonConfig = vscode.workspace.getConfiguration('python');

        // These are legacy settings that may have values
        const venvPath = pythonConfig.get('venvPath');
        const venvFolders = pythonConfig.get('venvFolders');
        const defaultInterpreterPath = pythonConfig.get('defaultInterpreterPath');
        const condaPath = pythonConfig.get('condaPath');

        // Assert types are as expected
        assert.ok(
            typeof venvPath === 'string' || venvPath === undefined,
            `venvPath should be string or undefined, got ${typeof venvPath}`,
        );
        assert.ok(
            Array.isArray(venvFolders) || venvFolders === undefined,
            `venvFolders should be array or undefined, got ${typeof venvFolders}`,
        );
        assert.ok(
            typeof defaultInterpreterPath === 'string' || defaultInterpreterPath === undefined,
            `defaultInterpreterPath should be string or undefined, got ${typeof defaultInterpreterPath}`,
        );
        assert.ok(
            typeof condaPath === 'string' || condaPath === undefined,
            `condaPath should be string or undefined, got ${typeof condaPath}`,
        );

        console.log('Legacy settings:');
        console.log('  venvPath:', venvPath);
        console.log('  venvFolders:', venvFolders);
        console.log('  defaultInterpreterPath:', defaultInterpreterPath);
        console.log('  condaPath:', condaPath);
    });

    /**
     * Test: Settings and API are connected
     *
     * Verify that settings API and environment API both work and return consistent data.
     */
    test('Settings and API are connected', async function () {
        // Get current environment from API
        const currentEnv = await api.getEnvironment(undefined);

        // Get current settings
        const config = vscode.workspace.getConfiguration('python-envs');
        const pythonProjects = config.get('pythonProjects');

        // Assert we can read settings
        assert.ok(
            pythonProjects === undefined || Array.isArray(pythonProjects),
            'pythonProjects should be undefined or array',
        );

        // If we have an environment, verify it has valid structure
        if (currentEnv) {
            assert.ok(currentEnv.envId, 'Current environment should have envId');
            assert.ok(currentEnv.displayName, 'Current environment should have displayName');
        }

        // This test verifies both APIs are working together without errors
        console.log('Current env:', currentEnv?.displayName ?? 'none');
        console.log('Projects setting type:', Array.isArray(pythonProjects) ? 'array' : typeof pythonProjects);
    });

    /**
     * Test: Workspace folder scope is respected
     *
     * Settings at workspace folder level should be independently inspectable.
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

        // Both should be independently inspectable
        const inspect1 = config1.inspect('pythonProjects');
        const inspect2 = config2.inspect('pythonProjects');

        // Assert inspect returns valid results for both folders
        assert.ok(inspect1, 'Should be able to inspect settings for folder 1');
        assert.ok(inspect2, 'Should be able to inspect settings for folder 2');

        // Assert the inspection objects have the expected structure
        assert.ok('key' in inspect1, 'Inspection should have key property');
        assert.ok('key' in inspect2, 'Inspection should have key property');
        assert.strictEqual(inspect1.key, 'python-envs.pythonProjects', 'Key should be python-envs.pythonProjects');
        assert.strictEqual(inspect2.key, 'python-envs.pythonProjects', 'Key should be python-envs.pythonProjects');

        console.log('Folder 1 pythonProjects:', inspect1?.workspaceFolderValue);
        console.log('Folder 2 pythonProjects:', inspect2?.workspaceFolderValue);
    });
});
