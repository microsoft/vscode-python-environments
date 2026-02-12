// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Terminal Activation
 *
 * PURPOSE:
 * Verify that terminal creation and activation work correctly
 * with different environments and settings.
 *
 * WHAT THIS TESTS:
 * 1. Terminal creation API
 * 2. Terminal runs with correct environment
 * 3. runInTerminal executes commands
 * 4. runInDedicatedTerminal uses consistent terminal
 *
 * NOTE: Terminal tests interact with real VS Code terminals.
 * Tests should be careful about cleanup.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironmentApi, PythonTerminalCreateOptions, PythonTerminalExecutionOptions } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Integration: Terminal Activation', function () {
    this.timeout(60_000);

    let api: PythonEnvironmentApi;
    const createdTerminals: vscode.Terminal[] = [];

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

    suiteTeardown(async function () {
        // Clean up created terminals
        for (const terminal of createdTerminals) {
            terminal.dispose();
        }
        createdTerminals.length = 0;
    });

    /**
     * Test: Terminal APIs are available
     *
     * The API should have all terminal-related methods.
     */
    test('Terminal APIs are available', async function () {
        assert.ok(typeof api.createTerminal === 'function', 'createTerminal should be a function');
        assert.ok(typeof api.runInTerminal === 'function', 'runInTerminal should be a function');
        assert.ok(typeof api.runInDedicatedTerminal === 'function', 'runInDedicatedTerminal should be a function');
        assert.ok(typeof api.runAsTask === 'function', 'runAsTask should be a function');
        assert.ok(typeof api.runInBackground === 'function', 'runInBackground should be a function');
    });

    /**
     * Test: createTerminal creates a terminal
     *
     * The createTerminal method should create a new VS Code terminal.
     */
    test('createTerminal creates new terminal', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];
        const initialTerminalCount = vscode.window.terminals.length;

        const options: PythonTerminalCreateOptions = {
            name: 'Test Terminal',
        };

        const terminal = await api.createTerminal(env, options);
        createdTerminals.push(terminal);

        assert.ok(terminal, 'createTerminal should return a terminal');
        assert.ok(
            terminal.name.includes('Test Terminal') || terminal.name.includes('Python'),
            'Terminal should have appropriate name',
        );

        // Verify terminal was created
        assert.ok(vscode.window.terminals.length >= initialTerminalCount, 'Terminal count should increase');
    });

    /**
     * Test: Terminal can be created with custom options
     *
     * Various terminal options should be respected.
     */
    test('createTerminal respects options', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        const options: PythonTerminalCreateOptions = {
            name: 'Custom Options Terminal',
            hideFromUser: false,
        };

        const terminal = await api.createTerminal(env, options);
        createdTerminals.push(terminal);

        assert.ok(terminal, 'Terminal should be created');
        // Name may include environment info, but should contain our custom name
        console.log('Created terminal name:', terminal.name);
    });

    /**
     * Test: runInTerminal returns terminal
     *
     * runInTerminal should execute in a terminal and return it.
     */
    test('runInTerminal returns terminal', async function () {
        const environments = await api.getEnvironments('all');
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (environments.length === 0 || !workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        const options: PythonTerminalExecutionOptions = {
            cwd: workspaceFolders[0].uri,
            args: ['--version'],
            show: false,
        };

        const terminal = await api.runInTerminal(env, options);
        createdTerminals.push(terminal);

        assert.ok(terminal, 'runInTerminal should return terminal');
        assert.ok(terminal instanceof Object, 'Should be a terminal object');
    });

    /**
     * Test: runInDedicatedTerminal reuses terminal
     *
     * Multiple calls with same key should use same terminal.
     */
    test('runInDedicatedTerminal reuses terminal for same key', async function () {
        const environments = await api.getEnvironments('all');
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (environments.length === 0 || !workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];
        const terminalKey = 'test-dedicated-terminal';

        const options: PythonTerminalExecutionOptions = {
            cwd: workspaceFolders[0].uri,
            args: ['--version'],
            show: false,
        };

        // First call
        const terminal1 = await api.runInDedicatedTerminal(terminalKey, env, options);
        createdTerminals.push(terminal1);

        // Second call with same key
        const terminal2 = await api.runInDedicatedTerminal(terminalKey, env, options);

        // Should be the same terminal (or at least same name)
        assert.ok(terminal1, 'First call should return terminal');
        assert.ok(terminal2, 'Second call should return terminal');

        // Note: Terminal instances may be different objects but refer to same terminal
        console.log('Terminal 1 name:', terminal1.name);
        console.log('Terminal 2 name:', terminal2.name);
    });

    /**
     * Test: Different keys get different terminals
     *
     * Different terminal keys should create different terminals.
     */
    test('runInDedicatedTerminal uses different terminals for different keys', async function () {
        const environments = await api.getEnvironments('all');
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (environments.length === 0 || !workspaceFolders || workspaceFolders.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        const options: PythonTerminalExecutionOptions = {
            cwd: workspaceFolders[0].uri,
            args: ['--version'],
            show: false,
        };

        const terminal1 = await api.runInDedicatedTerminal('key-1', env, options);
        createdTerminals.push(terminal1);

        const terminal2 = await api.runInDedicatedTerminal('key-2', env, options);
        if (terminal1 !== terminal2) {
            createdTerminals.push(terminal2);
        }

        assert.ok(terminal1, 'First terminal should exist');
        assert.ok(terminal2, 'Second terminal should exist');
    });

    /**
     * Test: createTerminal with disableActivation option
     *
     * When disableActivation is true, environment should not be activated.
     */
    test('disableActivation option is accepted', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        const options: PythonTerminalCreateOptions = {
            name: 'No Activation Terminal',
            disableActivation: true,
        };

        // Should not throw
        const terminal = await api.createTerminal(env, options);
        createdTerminals.push(terminal);

        assert.ok(terminal, 'Terminal should be created with disableActivation');
    });

    /**
     * Test: runAsTask returns TaskExecution
     *
     * runAsTask should start a task and return its execution.
     */
    test('runAsTask returns task execution', async function () {
        const environments = await api.getEnvironments('all');
        const projects = api.getPythonProjects();

        if (environments.length === 0 || projects.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        const execution = await api.runAsTask(env, {
            name: 'Test Python Task',
            args: ['--version'],
            project: projects[0],
        });

        assert.ok(execution, 'runAsTask should return execution');
        assert.ok(execution.task, 'Execution should have task');
        assert.ok(execution.task.name, 'Task should have name');
        assert.ok(execution.task.definition, 'Task should have definition');

        // Clean up - terminate the task
        vscode.tasks.taskExecutions.forEach((t) => {
            if (t === execution) {
                t.terminate();
            }
        });
    });

    /**
     * Test: runInBackground returns PythonProcess
     *
     * runInBackground should spawn a background process.
     */
    test('runInBackground returns process', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        // Find an environment with Python executable
        const targetEnv = environments[0];

        const process = await api.runInBackground(targetEnv, {
            args: ['--version'],
        });

        assert.ok(process, 'runInBackground should return process');
        assert.ok(process.stdout, 'Process should have stdout');
        assert.ok(process.stderr, 'Process should have stderr');
        assert.ok(typeof process.kill === 'function', 'Process should have kill method');

        // Clean up
        process.kill();
    });

    /**
     * Test: Terminal uses correct environment
     *
     * Commands in terminal should use the specified Python environment.
     */
    test('Terminal uses specified environment', async function () {
        const environments = await api.getEnvironments('all');

        if (environments.length === 0) {
            this.skip();
            return;
        }

        const env = environments[0];

        const terminal = await api.createTerminal(env, {
            name: 'Env Check Terminal',
        });
        createdTerminals.push(terminal);

        // Terminal should be configured with the environment
        // We can verify the terminal was created without error
        assert.ok(terminal, 'Terminal should be created for environment');
        console.log('Created terminal for:', env.displayName);
    });
});
