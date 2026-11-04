// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID, MAX_EXTENSION_ACTIVATION_TIME } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Smoke: Explicit Inline Scripts Setting', function () {
    this.timeout(MAX_EXTENSION_ACTIVATION_TIME);

    test('an explicit user setting enables inline-script registrations', async function () {
        if (process.env.VSC_PYTHON_INLINE_SCRIPTS_ENABLED_SMOKE_TEST !== '1') {
            this.skip();
        }

        const config = vscode.workspace.getConfiguration('python-envs');
        const inspected = config.inspect<boolean>('inlineScripts.enabled');
        assert.strictEqual(inspected?.globalValue, true, 'the dedicated test host should set a user value of true');
        assert.strictEqual(config.get<boolean>('inlineScripts.enabled'), true, 'the effective setting should be true');

        const extension = vscode.extensions.getExtension<PythonEnvironmentApi>(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);
        if (!extension.isActive) {
            await extension.activate();
        }

        await waitForCondition(
            async () => {
                const commands = await vscode.commands.getCommands(true);
                return (
                    commands.includes('python-envs.clearScriptEnvCache') &&
                    commands.includes('python-envs.setupInlineScriptEnvs')
                );
            },
            30_000,
            'inline-script commands were not registered while the explicit user setting was true',
        );
    });
});
