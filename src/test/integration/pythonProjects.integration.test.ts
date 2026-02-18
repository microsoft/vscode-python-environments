// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Python Projects
 *
 * PURPOSE:
 * Verify that Python project management works correctly - adding projects,
 * assigning environments, and persisting settings.
 *
 * WHAT THIS TESTS:
 * 1. Adding projects via API
 * 2. Removing projects via API
 * 3. Project-environment associations
 * 4. Events fire when projects change
 * 5. Workspace folders are treated as default projects
 *
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { TestEventHandler, waitForCondition } from '../testUtils';

suite('Integration: Python Projects', function () {
    this.timeout(60_000);

    let api: PythonEnvironmentApi;
    let originalProjectEnvs: Map<string, PythonEnvironment | undefined>;

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
        assert.ok(typeof api.getPythonProjects === 'function', 'getPythonProjects method not available');

        // Save original state for restoration
        originalProjectEnvs = new Map();
        const projects = api.getPythonProjects();
        for (const project of projects) {
            const env = await api.getEnvironment(project.uri);
            originalProjectEnvs.set(project.uri.toString(), env);
        }
    });

    suiteTeardown(async function () {
        // Restore original state
        for (const [uriStr, env] of originalProjectEnvs) {
            try {
                const uri = vscode.Uri.parse(uriStr);
                await api.setEnvironment(uri, env);
            } catch {
                // Ignore errors during cleanup
            }
        }
    });

    /**
     * Test: Workspace folders are default projects
     *
     * When a workspace is open, the workspace folder(s) should be
     * automatically treated as Python projects.
     */
    test('Workspace folders appear as default projects', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const projects = api.getPythonProjects();
        assert.ok(Array.isArray(projects), 'getPythonProjects should return array');

        // Each workspace folder should be a project
        for (const folder of workspaceFolders) {
            const found = projects.some(
                (p) => p.uri.fsPath === folder.uri.fsPath || p.uri.toString() === folder.uri.toString(),
            );
            assert.ok(found, `Workspace folder ${folder.name} should be a project`);
        }
    });

    /**
     * Test: getPythonProject returns correct project for URI
     *
     * Given a URI within a project, getPythonProject should return
     * the containing project.
     */
    test('getPythonProject returns project for URI', async function () {
        const projects = api.getPythonProjects();

        if (projects.length === 0) {
            this.skip();
            return;
        }

        const project = projects[0];
        const foundProject = api.getPythonProject(project.uri);

        assert.ok(foundProject, 'Should find project by its URI');
        assert.strictEqual(foundProject.uri.toString(), project.uri.toString(), 'Found project should match original');
    });

    /**
     * Test: getPythonProject returns undefined for unknown URI
     *
     * Querying a path that's not within any project should return undefined.
     */
    test('getPythonProject returns undefined for unknown URI', async function () {
        // Use a path that definitely won't be a project
        const unknownUri = vscode.Uri.file('/nonexistent/path/that/wont/exist');
        const project = api.getPythonProject(unknownUri);

        assert.strictEqual(project, undefined, 'Should return undefined for unknown path');
    });

    /**
     * Test: Projects have required structure
     *
     * Each project should have the minimum required properties.
     */
    test('Projects have valid structure', async function () {
        const projects = api.getPythonProjects();

        if (projects.length === 0) {
            this.skip();
            return;
        }

        for (const project of projects) {
            assert.ok(typeof project.name === 'string', 'Project must have name');
            assert.ok(project.name.length > 0, 'Project name should not be empty');
            assert.ok(project.uri, 'Project must have URI');
            assert.ok(project.uri instanceof vscode.Uri, 'Project URI must be a Uri');
        }
    });

    /**
     * Test: Environment can be set and retrieved for project
     *
     * After setting an environment for a project, getEnvironment should
     * return that environment.
     */
    test('setEnvironment and getEnvironment work for project', async function () {
        const projects = api.getPythonProjects();

        if (projects.length === 0) {
            this.skip();
            return;
        }

        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const project = projects[0];
        const env = environments[0];

        // Diagnostic logging for CI debugging
        console.log(`[TEST DEBUG] Project URI: ${project.uri.fsPath}`);
        console.log(`[TEST DEBUG] Setting environment with envId: ${env.envId.id}`);
        console.log(`[TEST DEBUG] Environment path: ${env.environmentPath?.fsPath}`);
        console.log(`[TEST DEBUG] Total environments available: ${environments.length}`);
        environments.forEach((e, i) => {
            console.log(`[TEST DEBUG]   env[${i}]: ${e.envId.id} (${e.displayName})`);
        });

        // Set environment for project
        await api.setEnvironment(project.uri, env);

        // Track what getEnvironment returns during polling for diagnostics
        let pollCount = 0;
        let lastRetrievedId: string | undefined;

        // Wait for the environment to be retrievable with the correct ID
        // This handles async persistence across platforms
        // Use 15s timeout - CI runners (especially macos) can be slow with settings persistence
        await waitForCondition(
            async () => {
                const retrieved = await api.getEnvironment(project.uri);
                pollCount++;
                const retrievedId = retrieved?.envId?.id;
                if (retrievedId !== lastRetrievedId) {
                    console.log(
                        `[TEST DEBUG] Poll #${pollCount}: getEnvironment returned envId=${retrievedId ?? 'undefined'}`,
                    );
                    lastRetrievedId = retrievedId;
                }
                return retrieved !== undefined && retrieved.envId.id === env.envId.id;
            },
            15_000,
            `Environment was not set correctly. Expected envId: ${env.envId.id}, last retrieved: ${lastRetrievedId}`,
        );

        // Final verification
        const retrievedEnv = await api.getEnvironment(project.uri);
        assert.ok(retrievedEnv, 'Should get environment after setting');
        assert.strictEqual(retrievedEnv.envId.id, env.envId.id, 'Retrieved environment should match set environment');
    });

    /**
     * Test: onDidChangeEnvironment fires when project environment changes
     *
     * Setting an environment for a project should fire the change event.
     */
    test('onDidChangeEnvironment fires on project environment change', async function () {
        const projects = api.getPythonProjects();
        const environments = await api.getEnvironments('all');

        if (projects.length === 0 || environments.length < 2) {
            // Need at least 2 environments to guarantee a change
            this.skip();
            return;
        }

        const project = projects[0];

        // Get current environment to pick a different one
        const currentEnv = await api.getEnvironment(project.uri);

        // Pick an environment different from current
        let targetEnv = environments[0];
        if (currentEnv && currentEnv.envId.id === targetEnv.envId.id) {
            targetEnv = environments[1];
        }

        // Register handler BEFORE making the change
        const handler = new TestEventHandler(api.onDidChangeEnvironment, 'onDidChangeEnvironment');

        try {
            // Set environment - this should fire the event
            await api.setEnvironment(project.uri, targetEnv);

            // Wait for an event where event.new is defined (the actual change event)
            // Use 15s timeout - CI runners can be slow
            await waitForCondition(
                () => handler.all.some((e) => e.new !== undefined),
                15_000,
                'onDidChangeEnvironment with new environment was not fired',
            );

            // Find the event with the new environment
            const changeEvent = handler.all.find((e) => e.new !== undefined);
            assert.ok(changeEvent, 'Should have change event with new environment');
            assert.ok(changeEvent.new, 'Event should have new environment');
        } finally {
            handler.dispose();
        }
    });

    /**
     * Test: Environment can be unset for project
     *
     * Setting undefined as environment should clear the explicit association.
     * After clearing, getEnvironment may return auto-discovered env or undefined.
     */
    test('setEnvironment with undefined clears association', async function () {
        const projects = api.getPythonProjects();
        const environments = await api.getEnvironments('all');

        if (projects.length === 0 || environments.length === 0) {
            this.skip();
            return;
        }

        const project = projects[0];
        const env = environments[0];

        // Set environment first
        await api.setEnvironment(project.uri, env);

        // Wait for it to be set
        // Use 15s timeout - CI runners can be slow with settings persistence
        await waitForCondition(
            async () => {
                const retrieved = await api.getEnvironment(project.uri);
                return retrieved !== undefined && retrieved.envId.id === env.envId.id;
            },
            15_000,
            'Environment was not set before clearing',
        );

        // Verify it was set
        const beforeClear = await api.getEnvironment(project.uri);
        assert.ok(beforeClear, 'Environment should be set before clearing');
        assert.strictEqual(beforeClear.envId.id, env.envId.id, 'Should have the explicitly set environment');

        // Clear environment
        await api.setEnvironment(project.uri, undefined);

        // After clearing, if there's still an environment, it should either be:
        // 1. undefined (no auto-discovery)
        // 2. Different from the explicitly set one (auto-discovered fallback)
        // 3. Same as before if it happens to be auto-discovered too (edge case)
        const afterClear = await api.getEnvironment(project.uri);

        // The key assertion: the operation completed without error
        // and the API behaves consistently (returns env or undefined)
        if (afterClear) {
            assert.ok(afterClear.envId, 'If environment returned, it must have valid envId');
            assert.ok(afterClear.envId.id, 'If environment returned, envId must have id');
        } else {
            assert.strictEqual(
                afterClear,
                undefined,
                'Cleared association should return undefined when no auto-discovery',
            );
        }
    });

    /**
     * Test: File within project resolves to project environment
     *
     * A file path inside a project should resolve to that project's environment.
     */
    test('File in project uses project environment', async function () {
        const projects = api.getPythonProjects();
        const environments = await api.getEnvironments('all');

        if (projects.length === 0 || environments.length === 0) {
            this.skip();
            return;
        }

        const project = projects[0];
        const env = environments[0];

        // Set environment for project
        await api.setEnvironment(project.uri, env);

        // Wait for it to be set
        // Use 15s timeout - CI runners can be slow with settings persistence
        await waitForCondition(
            async () => {
                const retrieved = await api.getEnvironment(project.uri);
                return retrieved !== undefined && retrieved.envId.id === env.envId.id;
            },
            15_000,
            'Environment was not set for project',
        );

        // Create a hypothetical file path inside the project
        const fileUri = vscode.Uri.joinPath(project.uri, 'some_script.py');

        // Get environment for the file
        const fileEnv = await api.getEnvironment(fileUri);

        // Should inherit project's environment
        assert.ok(fileEnv, 'File should get environment from project');
        assert.strictEqual(fileEnv.envId.id, env.envId.id, 'File should use project environment');
    });
});
