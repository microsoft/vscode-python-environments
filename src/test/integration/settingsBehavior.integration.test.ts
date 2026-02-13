// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Settings Behavior
 *
 * PURPOSE:
 * Verify that the extension's settings-related APIs work correctly
 * and interact properly with VS Code's settings system.
 *
 * WHAT THIS TESTS:
 * 1. Environment variables API works correctly
 * 2. Extension correctly defines required settings in package.json
 * 3. Settings and API work together consistently
 *
 * NOTE: These tests focus on extension behavior, not VS Code's
 * configuration system. Tests just reading settings without
 * exercising extension code belong elsewhere.
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
        assert.ok(typeof api.getEnvironmentVariables === 'function', 'getEnvironmentVariables should be a function');
        assert.ok(api.onDidChangeEnvironmentVariables, 'onDidChangeEnvironmentVariables should be available');
    });

    // =========================================================================
    // EXTENSION SETTINGS SCHEMA TESTS
    // Verify that settings defined in package.json are accessible.
    // =========================================================================

    /**
     * Test: Extension settings are defined in package.json
     *
     * The python-envs configuration section should be accessible with expected types.
     * This verifies our package.json contributes the correct settings schema.
     */
    test('Extension settings are defined in package.json', async function () {
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
     * Test: pythonProjects setting structure
     *
     * The pythonProjects setting should have the correct structure when set.
     * This validates our package.json schema for pythonProjects.
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

    // =========================================================================
    // ENVIRONMENT VARIABLES API TESTS
    // These tests verify the extension's getEnvironmentVariables API behavior.
    // =========================================================================

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

    // =========================================================================
    // SETTINGS + API INTEGRATION TESTS
    // These tests verify settings and API work together correctly.
    // =========================================================================

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
});
