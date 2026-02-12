// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Smoke Test: Functional Checks
 *
 * PURPOSE:
 * Verify that core extension features actually work, not just that they're registered.
 * These tests require Python to be installed and may have side effects.
 *
 * WHAT THIS TESTS:
 * 1. Environment discovery returns results
 * 2. Projects API works correctly
 * 3. Environment variables API works
 * 4. Settings are not polluted on activation
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID, MAX_EXTENSION_ACTIVATION_TIME } from '../constants';
import { waitForApiReady, waitForCondition } from '../testUtils';

suite('Smoke: Functional Checks', function () {
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

        // Wait for environment managers to register (happens async in setImmediate)
        // This may fail in CI if the pet binary is not available
        const result = await waitForApiReady(api, 45_000);
        managersReady = result.ready;
        if (!result.ready) {
            console.log(`[WARN] Managers not ready: ${result.error}`);
            console.log('[WARN] Tests requiring managers will be skipped');
        }
    });

    // =========================================================================
    // ENVIRONMENT DISCOVERY - Core feature must work
    // =========================================================================

    test('getEnvironments returns an array', async function () {
        // Skip if managers aren't ready (e.g., pet binary not available in CI)
        if (!managersReady) {
            this.skip();
            return;
        }

        // This test verifies discovery machinery works
        // Even if no Python is installed, it should return an empty array, not throw

        const environments = await api.getEnvironments('all');

        assert.ok(Array.isArray(environments), 'getEnvironments("all") should return an array');
    });

    test('getEnvironments finds Python installations when available', async function () {
        // Skip if managers aren't ready (e.g., pet binary not available in CI)
        if (!managersReady) {
            this.skip();
            return;
        }

        // Skip this test if no Python is expected (CI without Python)
        if (process.env.SKIP_PYTHON_TESTS) {
            this.skip();
            return;
        }

        const environments = await api.getEnvironments('all');

        // On a typical dev machine, we expect at least one Python
        // This test may need to be conditional based on CI environment
        if (environments.length === 0) {
            console.log('[WARN] No Python environments found - is Python installed?');
            // Don't fail - just warn. CI may not have Python.
            return;
        }

        // Verify environment structure
        const env = environments[0];
        assert.ok(env.envId, 'Environment should have envId');
        assert.ok(env.envId.id, 'envId.id should be defined');
        assert.ok(env.envId.managerId, 'envId.managerId should be defined');
        assert.ok(env.name, 'Environment should have a name');
        assert.ok(env.version, 'Environment should have a version');
        assert.ok(env.environmentPath, 'Environment should have environmentPath');
    });

    test('getEnvironments with scope "global" returns global interpreters', async function () {
        const globalEnvs = await api.getEnvironments('global');

        assert.ok(Array.isArray(globalEnvs), 'getEnvironments("global") should return an array');

        // Global environments are system Python installations
        // They should be a subset of 'all' environments
        const allEnvs = await api.getEnvironments('all');
        assert.ok(globalEnvs.length <= allEnvs.length, 'Global environments should be a subset of all environments');
    });

    test('refreshEnvironments completes without error', async function () {
        // This should not throw
        await api.refreshEnvironments(undefined);

        // Verify we can still get environments after refresh
        const environments = await api.getEnvironments('all');
        assert.ok(Array.isArray(environments), 'Should be able to get environments after refresh');
    });

    // =========================================================================
    // PROJECTS - Core project management features
    // =========================================================================

    test('getPythonProjects returns workspace folders by default', function () {
        const projects = api.getPythonProjects();

        assert.ok(Array.isArray(projects), 'getPythonProjects should return an array');

        // By default, workspace folders are treated as projects
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            assert.ok(projects.length > 0, 'With workspace folders open, there should be at least one project');

            // Verify project structure
            const project = projects[0];
            assert.ok(project.name, 'Project should have a name');
            assert.ok(project.uri, 'Project should have a uri');
        }
    });

    test('getPythonProject returns undefined for non-existent path', function () {
        const fakeUri = vscode.Uri.file('/this/path/does/not/exist/anywhere');
        const project = api.getPythonProject(fakeUri);

        // Should return undefined, not throw
        assert.strictEqual(project, undefined, 'getPythonProject should return undefined for non-existent path');
    });

    // =========================================================================
    // ENVIRONMENT SELECTION - Get/Set environment
    // =========================================================================

    test('getEnvironment returns undefined or a valid environment', async function () {
        // With no explicit selection, may return undefined or auto-selected env
        const env = await api.getEnvironment(undefined);

        if (env !== undefined) {
            // If an environment is returned, verify its structure
            assert.ok(env.envId, 'Returned environment should have envId');
            assert.ok(env.name, 'Returned environment should have name');
        }
        // undefined is also valid - no environment selected
    });

    // =========================================================================
    // ENVIRONMENT VARIABLES - .env file support
    // =========================================================================

    test('getEnvironmentVariables returns an object', async function () {
        const envVars = await api.getEnvironmentVariables(undefined);

        assert.ok(envVars !== null, 'getEnvironmentVariables should not return null');
        assert.ok(typeof envVars === 'object', 'getEnvironmentVariables should return an object');

        // Should at least contain PATH or similar system variables
        // (merged from process.env by default)
        const hasKeys = Object.keys(envVars).length > 0;
        assert.ok(hasKeys, 'Environment variables object should have some entries');
    });

    test('getEnvironmentVariables with workspace uri works', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const workspaceUri = workspaceFolders[0].uri;
        const envVars = await api.getEnvironmentVariables(workspaceUri);

        assert.ok(envVars !== null, 'getEnvironmentVariables with workspace uri should not return null');
        assert.ok(typeof envVars === 'object', 'Should return an object');
    });

    // =========================================================================
    // RESOLVE ENVIRONMENT - Detailed environment info
    // =========================================================================

    test('resolveEnvironment handles invalid path gracefully', async function () {
        const fakeUri = vscode.Uri.file('/this/is/not/a/python/installation');

        // Should return undefined, not throw
        const resolved = await api.resolveEnvironment(fakeUri);
        assert.strictEqual(resolved, undefined, 'resolveEnvironment should return undefined for invalid path');
    });

    test('resolveEnvironment returns full details for valid environment', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Try to resolve the first environment's path
        const env = environments[0];
        const resolved = await api.resolveEnvironment(env.environmentPath);

        if (resolved) {
            // Verify resolved environment has execution info
            assert.ok(resolved.execInfo, 'Resolved environment should have execInfo');
            assert.ok(resolved.execInfo.run, 'execInfo should have run configuration');
            assert.ok(resolved.execInfo.run.executable, 'run should have executable path');
        }
    });

    // =========================================================================
    // PACKAGES - Package listing (read-only)
    // =========================================================================

    test('getPackages returns array or undefined for valid environment', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];
        const packages = await api.getPackages(env);

        // Should return array or undefined, not throw
        assert.ok(packages === undefined || Array.isArray(packages), 'getPackages should return undefined or an array');

        // If packages exist, verify structure
        if (packages && packages.length > 0) {
            const pkg = packages[0];
            assert.ok(pkg.pkgId, 'Package should have pkgId');
            assert.ok(pkg.name, 'Package should have name');
        }
    });
});
