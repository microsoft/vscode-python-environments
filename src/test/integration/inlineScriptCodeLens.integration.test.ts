// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { readInlineScriptMetadata } from '../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { registerInlineScriptCodeLens } from '../../features/inlineScript/codeLens';
import { registerInlineScriptDiagnostics } from '../../features/inlineScript/diagnostics';
import { InlineScriptLazyDetector } from '../../features/inlineScript/lazyDetector';
import { sleep, waitForCondition } from '../testUtils';

const SETUP_COMMAND = 'python-envs.test.inlineScriptLensSetup';
const SCRIPT = '# /// script\n# dependencies = []\n# ///\n\nprint("hello")\n';

suite('Integration: Live inline script CodeLens', function () {
    this.timeout(30_000);

    let root: string;
    let document: vscode.TextDocument;
    let routing: InlineScriptRoutingRegistry;
    let registration: vscode.Disposable;
    let diagnostics: vscode.Disposable;
    let detector: InlineScriptLazyDetector;
    let nextFile = 0;

    suiteSetup(async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspace, 'Inline CodeLens integration tests require an open workspace');
        root = await fs.mkdtemp(path.join(workspace.uri.fsPath, 'pep723-lens-integration-'));
    });

    setup(async () => {
        routing = new InlineScriptRoutingRegistry();
        registration = registerInlineScriptCodeLens(routing, SETUP_COMMAND).disposable;
        diagnostics = registerInlineScriptDiagnostics();
        detector = new InlineScriptLazyDetector(routing);
        detector.activate();
        const uri = vscode.Uri.file(path.join(root, `script-${nextFile++}.py`));
        await fs.writeFile(uri.fsPath, SCRIPT);
        document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        await waitForCondition(
            () => routing.getMetadata(document.uri) !== undefined,
            5_000,
            'The detector should read the saved script before editing',
        );
    });

    teardown(async () => {
        registration.dispose();
        diagnostics.dispose();
        detector.dispose();
        routing.dispose();
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    suiteTeardown(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    async function lenses(): Promise<vscode.CodeLens[]> {
        const all = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            document.uri,
        );
        return (all ?? []).filter(
            (lens) =>
                lens.command?.command === SETUP_COMMAND || lens.command?.title.startsWith('Script environment ready'),
        );
    }

    async function replace(text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            text,
        );
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    }

    function validateSavedEnvironment(version = '3.12.4'): void {
        const metadata = readInlineScriptMetadata(document.getText());
        assert.ok(metadata);
        routing.setMetadata(document.uri, metadata);
        routing.setValidatedAssociation(document.uri, true, version);
    }

    test('offers setup for unsaved malformed metadata while diagnostics remain visible', async () => {
        await replace('# /// script\n# dependencies = [\n# ///\n');
        assert.strictEqual(document.isDirty, true);
        const found = await lenses();
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].command?.command, SETUP_COMMAND);
        await waitForCondition(
            () =>
                vscode.languages.getDiagnostics(document.uri).some((diagnostic) => diagnostic.code === 'invalid-toml'),
            5_000,
            'Malformed inline metadata should retain its diagnostic',
        );
    });

    test('retains setup for an unfinished marker block before any save', async () => {
        await replace('# /// script');
        assert.strictEqual((await lenses())[0]?.command?.command, SETUP_COMMAND);
        await waitForCondition(
            () =>
                vscode.languages.getDiagnostics(document.uri).some((diagnostic) => diagnostic.code === 'unterminated-block'),
            5_000,
            'Unfinished inline metadata should retain its diagnostic',
        );
    });

    test('keeps a validated ready label beyond the former five-second expiry', async () => {
        validateSavedEnvironment();
        assert.strictEqual((await lenses())[0]?.command?.title, 'Script environment ready (Python 3.12.4)');
        await sleep(5_200);
        const found = await lenses();
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].command?.command, '');
        assert.strictEqual(found[0].command?.title, 'Script environment ready (Python 3.12.4)');
    });

    test('body edits keep ready while block edits offer setup and Undo restores ready without saving', async () => {
        validateSavedEnvironment();
        await replace(SCRIPT.replace('hello', 'dirty body'));
        assert.strictEqual(document.isDirty, true);
        assert.strictEqual((await lenses())[0]?.command?.command, '');
        await replace(SCRIPT.replace('[]', '["requests"]'));
        assert.strictEqual((await lenses())[0]?.command?.command, SETUP_COMMAND);
        assert.strictEqual(routing.shouldRoute(document.uri), false, 'the detector must still invalidate changed headers');
        await replace(SCRIPT);
        assert.strictEqual((await lenses())[0]?.command?.command, '');
        assert.strictEqual(routing.shouldRoute(document.uri), true, 'Undo must restore the validated route');
    });

    test('restored associations show the version and availability changes switch the label', async () => {
        validateSavedEnvironment('3.13.2');
        registration.dispose();
        registration = registerInlineScriptCodeLens(routing, SETUP_COMMAND).disposable;
        assert.strictEqual((await lenses())[0]?.command?.title, 'Script environment ready (Python 3.13.2)');
        routing.setEnvironmentUnavailable(document.uri, true);
        assert.strictEqual((await lenses())[0]?.command?.command, SETUP_COMMAND);
        routing.setEnvironmentUnavailable(document.uri, false);
        assert.strictEqual((await lenses())[0]?.command?.command, '');
    });

    test('ordinary files and removed blocks have no inline CodeLens', async () => {
        validateSavedEnvironment();
        await replace('print("ordinary Python")\n');
        assert.deepStrictEqual(await lenses(), []);
    });

    test('a saved and revalidated block restores ready without an expiry timer', async () => {
        validateSavedEnvironment();
        await replace(SCRIPT.replace('dependencies = []', 'dependencies=[]'));
        assert.strictEqual((await lenses())[0]?.command?.command, SETUP_COMMAND);
        assert.strictEqual(await document.save(), true);
        validateSavedEnvironment();
        assert.strictEqual((await lenses())[0]?.command?.command, '');
    });

    test('compares a real normalized text document against its mixed-ending disk metadata', async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        const uri = vscode.Uri.file(path.join(root, 'mixed-endings.py'));
        const disk = '# /// script\r\n# dependencies = []\n# ///\rprint("hello")';
        await fs.writeFile(uri.fsPath, disk);
        document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        assert.notStrictEqual(document.getText(), disk, 'VS Code should normalize the mixed line endings');
        const metadata = readInlineScriptMetadata(await fs.readFile(uri.fsPath, 'utf8'));
        assert.ok(metadata);
        routing.setMetadata(uri, metadata);
        routing.setValidatedAssociation(uri, true, '3.12.4');
        assert.strictEqual((await lenses())[0]?.command?.title, 'Script environment ready (Python 3.12.4)');
    });
});
