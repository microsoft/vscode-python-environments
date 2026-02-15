// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Multi-Root Workspace
 *
 * PURPOSE:
 * Verify behavior that requires multiple workspace folders open simultaneously.
 * These tests run in a multi-root workspace (.code-workspace) with 2+ folders.
 *
 * WHAT THIS TESTS:
 * 1. Different projects can have independent environment selections
 * 2. setEnvironment handles URI arrays across projects
 * 3. Settings scope is isolated between workspace folders
 * 4. Environment creation with multiple URI scopes
 *
 * NOTE: These tests require a multi-root workspace with at least 2 workspace folders.
 * They will skip if run in a single-folder workspace.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import { ENVS_EXTENSION_ID } from '../../constants';
import { waitForCondition } from '../../testUtils';

suite('Integration: Multi-Root Workspace', function () {
    this.timeout(120_000);

    let api: PythonEnvironmentApi;
    let originalProjectEnvs: Map<string, PythonEnvironment | undefined>;

    suiteSetup(async function () {
        this.timeout(30_000);

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length < 2) {
            this.skip();
            return;
        }

        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 20_000, 'Extension did not activate');
        }

        api = extension.exports as PythonEnvironmentApi;
        assert.ok(api, 'API not available');

        // Save original state for restoration
        originalProjectEnvs = new Map();
        const projects = api.getPythonProjects();
        for (const project of projects) {
            const env = await api.getEnvironment(project.uri);
            originalProjectEnvs.set(project.uri.toString(), env);
        }
    });

    suiteTeardown(async function () {
        if (!originalProjectEnvs) {
            return;
        }
        // Restore original state
        for (const [uriStr, env] of originalProjectEnvs) {
            try {
                const uri = vscode.Uri.parse(uriStr);
                await api.setEnvironment(uri, env);
            } catch {
                // Best effort restore
            }
        }
    });

    /**
     * Test: Multiple projects can have different environments
     *
     * In a multi-project workspace, each project can have its own environment.
     */
    test('Different projects can have different environments', async function () {
        const projects = api.getPythonProjects();
        const environments = await api.getEnvironments('all');

        if (projects.length < 2 || environments.length < 2) {
            this.skip();
            return;
        }

        const project1 = projects[0];
        const project2 = projects[1];
        const env1 = environments[0];
        const env2 = environments[1];

        // Set different environments for different projects
        await api.setEnvironment(project1.uri, env1);
        await api.setEnvironment(project2.uri, env2);

        // Verify each project has its assigned environment
        const retrieved1 = await api.getEnvironment(project1.uri);
        const retrieved2 = await api.getEnvironment(project2.uri);

        assert.ok(retrieved1, 'Project 1 should have environment');
        assert.ok(retrieved2, 'Project 2 should have environment');
        assert.strictEqual(retrieved1.envId.id, env1.envId.id, 'Project 1 should have env1');
        assert.strictEqual(retrieved2.envId.id, env2.envId.id, 'Project 2 should have env2');
    });

    /**
     * Test: setEnvironment handles URI arrays across projects
     *
     * setEnvironment should handle array of URIs for multi-select scenarios.
     */
    test('setEnvironment handles URI array', async function () {
        const environments = await api.getEnvironments('all');
        const projects = api.getPythonProjects();

        if (environments.length === 0 || projects.length < 2) {
            this.skip();
            return;
        }

        const env = environments[0];
        const uris = projects.slice(0, 2).map((p) => p.uri);

        // Set environment for multiple URIs at once
        await api.setEnvironment(uris, env);

        // Verify both projects have the environment
        for (const uri of uris) {
            const retrieved = await api.getEnvironment(uri);
            assert.ok(retrieved, `URI ${uri.fsPath} should have environment`);
            assert.strictEqual(retrieved.envId.id, env.envId.id, `URI ${uri.fsPath} should have set environment`);
        }
    });

    /**
     * Test: Workspace folder settings scope is respected
     *
     * Settings at workspace folder level should be independently accessible
     * across different folders.
     */
    test('Workspace folder settings scope is respected', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders!;

        const config1 = vscode.workspace.getConfiguration('python-envs', workspaceFolders[0].uri);
        const config2 = vscode.workspace.getConfiguration('python-envs', workspaceFolders[1].uri);

        // Both should be independently accessible via inspect()
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
    });

    /**
     * Test: Creation with multiple URIs selects manager
     *
     * When passing multiple workspace folder URIs, the API should handle
     * manager selection and create an environment.
     */
    test('Multiple URI scope creation is handled', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders!;
        const uris = workspaceFolders.map((f) => f.uri);
        let createdEnv: PythonEnvironment | undefined;

        try {
            // This may prompt for manager selection - quickCreate should handle it
            createdEnv = await api.createEnvironment(uris, { quickCreate: true });

            if (createdEnv) {
                // Verify created environment has valid structure
                assert.ok(createdEnv.envId, 'Multi-URI created env must have envId');
                assert.ok(createdEnv.environmentPath, 'Multi-URI created env must have environmentPath');
            } else {
                // quickCreate returned undefined - skip this test as feature not available
                this.skip();
                return;
            }
        } finally {
            // Cleanup: always try to remove if created
            if (createdEnv) {
                await api.removeEnvironment(createdEnv);
            }
        }
    });
});
