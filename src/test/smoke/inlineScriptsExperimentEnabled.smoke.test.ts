// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Smoke: Delayed Inline Scripts Experiment Default', function () {
    this.timeout(120_000);

    test('a late experimental default activates all inline-script registrations', async function () {
        if (process.env.VSC_PYTHON_INLINE_SCRIPTS_EXPERIMENT_SMOKE_TEST !== '1') {
            this.skip();
        }

        const config = vscode.workspace.getConfiguration('python-envs');
        const inspectedBeforeActivation = config.inspect<boolean>('inlineScripts.enabled');
        assert.strictEqual(inspectedBeforeActivation?.globalValue, undefined);
        assert.strictEqual(inspectedBeforeActivation?.workspaceValue, undefined);
        assert.strictEqual(inspectedBeforeActivation?.workspaceFolderValue, undefined);
        assert.strictEqual(
            config.get<boolean>('inlineScripts.enabled'),
            false,
            'the delayed experiment override should still be pending before extension activation',
        );

        const extension = vscode.extensions.getExtension<PythonEnvironmentApi>(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);
        if (!extension.isActive) {
            await extension.activate();
        }
        assert.strictEqual(extension.isActive, true);
        assert.strictEqual(
            vscode.workspace.getConfiguration('python-envs').get<boolean>('inlineScripts.enabled'),
            false,
            'the extension must be active before the delayed experimental default is applied',
        );

        const commandsImmediatelyAfterActivation = await vscode.commands.getCommands(true);
        assert.ok(
            !commandsImmediatelyAfterActivation.includes('python-envs.setupInlineScriptEnv'),
            'the hidden setup command should not register before the experimental default arrives',
        );

        await waitForCondition(
            () => vscode.workspace.getConfiguration('python-envs').get<boolean>('inlineScripts.enabled') === true,
            45_000,
            'VS Code did not apply the delayed inline-script experimental default',
        );
        await waitForCondition(
            async () => {
                const commands = await vscode.commands.getCommands(true);
                return (
                    commands.includes('python-envs.setupInlineScriptEnv') &&
                    commands.includes('python-envs.clearScriptEnvCache') &&
                    commands.includes('python-envs.setupInlineScriptEnvs')
                );
            },
            45_000,
            'the inline-script feature did not register after the experimental default became true',
        );

        const inspectedAfterActivation = vscode.workspace
            .getConfiguration('python-envs')
            .inspect<boolean>('inlineScripts.enabled');
        assert.strictEqual(inspectedAfterActivation?.globalValue, undefined);
        assert.strictEqual(inspectedAfterActivation?.defaultValue, true);

        const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pep723-exp-smoke-'));
        const scriptUri = vscode.Uri.file(path.join(tempDirectory, 'script.py'));
        try {
            await fs.writeFile(
                scriptUri.fsPath,
                '# /// script\n# requires-python = ">=3.10"\n# dependencies = []\n# ///\n\nprint("hello")\n',
            );
            const document = await vscode.workspace.openTextDocument(scriptUri);
            await vscode.window.showTextDocument(document);
            await waitForCondition(
                async () => {
                    const lenses =
                        (await vscode.commands.executeCommand<vscode.CodeLens[]>(
                            'vscode.executeCodeLensProvider',
                            scriptUri,
                        )) ?? [];
                    return lenses.some((lens) => lens.command?.command === 'python-envs.setupInlineScriptEnv');
                },
                10_000,
                'the delayed activation did not surface the inline-script setup CodeLens',
            );
        } finally {
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            await fs.rm(tempDirectory, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 100,
            });
        }
    });
});
