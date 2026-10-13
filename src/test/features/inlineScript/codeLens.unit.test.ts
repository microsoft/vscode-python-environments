// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    Disposable,
    TextDocumentChangeEvent,
    TextDocumentContentChangeEvent,
    Uri,
} from 'vscode';
import { MAX_HEADER_BYTES, readInlineScriptMetadata } from '../../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import * as wapi from '../../../common/workspace.apis';
import { InlineScriptCodeLensProvider } from '../../../features/inlineScript/codeLens';
import { MockDocument } from '../../mocks/mockDocument';

const SETUP_COMMAND = 'python-envs.setupInlineScriptEnv';
const SCRIPT = '# /// script\n# dependencies = ["requests"]\n# ///\n\nprint("hello")\n';

suite('Inline script CodeLens provider', () => {
    const scriptUri = Uri.file(path.join(process.cwd(), 'lens-tests', 'app.py'));
    let routing: InlineScriptRoutingRegistry;
    let provider: InlineScriptCodeLensProvider;
    let changeListener: ((event: TextDocumentChangeEvent) => void) | undefined;

    setup(() => {
        changeListener = undefined;
        sinon.stub(wapi, 'onDidChangeTextDocument').callsFake((listener) => {
            changeListener = listener;
            return new Disposable(() => {
                changeListener = undefined;
            });
        });
        routing = new InlineScriptRoutingRegistry();
        provider = new InlineScriptCodeLensProvider(routing, SETUP_COMMAND);
    });

    teardown(() => {
        provider.dispose();
        routing.dispose();
        sinon.restore();
    });

    function document(text = SCRIPT, dirty = false, uri = scriptUri): MockDocument {
        const doc = new MockDocument(text, uri.fsPath, async () => true);
        sinon.stub(doc, 'uri').get(() => uri);
        sinon.stub(doc, 'isDirty').get(() => dirty);
        return doc;
    }

    function ready(text = SCRIPT, version: string | undefined = '3.12.4', uri = scriptUri): void {
        const metadata = readInlineScriptMetadata(text);
        assert.ok(metadata);
        routing.setMetadata(uri, metadata);
        routing.setValidatedAssociation(uri, true, version);
    }

    function lens(text = SCRIPT, dirty = false, uri = scriptUri) {
        const lenses = provider.provideCodeLenses(document(text, dirty, uri), {} as never);
        assert.strictEqual(lenses.length, 1);
        return lenses[0];
    }

    function fireChange(
        text: string,
        rangeOffset: number,
        rangeLength: number,
        insertedText: string,
        uri = scriptUri,
    ): void {
        assert.ok(changeListener, 'document change listener should be registered');
        const contentChange: TextDocumentContentChangeEvent = {
            range: undefined as never,
            rangeOffset,
            rangeLength,
            text: insertedText,
        };
        changeListener({
            document: document(text, true, uri),
            contentChanges: [contentChange],
            reason: undefined,
        });
    }

    test('does not decorate ordinary Python files', () => {
        assert.deepStrictEqual(provider.provideCodeLenses(document('print("hello")'), {} as never), []);
    });

    test('refreshes when a dirty ordinary file gains its first script block', () => {
        assert.deepStrictEqual(provider.provideCodeLenses(document('print("hello")'), {} as never), []);
        const changed = sinon.spy();
        provider.onDidChangeCodeLenses(changed);

        fireChange(SCRIPT, 0, 0, SCRIPT);

        sinon.assert.calledOnce(changed);
        assert.strictEqual(lens(SCRIPT, true).command?.command, SETUP_COMMAND);
    });

    test('refreshes when dirty inline metadata changes before routing catches up', () => {
        ready();
        assert.strictEqual(lens().command?.command, '');
        const changed = sinon.spy();
        provider.onDidChangeCodeLenses(changed);
        const edited = SCRIPT.replace('requests', 'httpx');

        fireChange(edited, SCRIPT.indexOf('requests'), 'requests'.length, 'httpx');

        sinon.assert.calledOnce(changed);
        assert.strictEqual(lens(edited, true).command?.command, SETUP_COMMAND);
    });

    test('does not refresh for a body-only edit after the inline block', () => {
        ready();
        assert.strictEqual(lens().command?.command, '');
        const changed = sinon.spy();
        provider.onDidChangeCodeLenses(changed);
        const edited = SCRIPT.replace('hello', 'changed body');

        fireChange(edited, SCRIPT.indexOf('hello'), 'hello'.length, 'changed body');

        sinon.assert.notCalled(changed);
    });

    test('refreshes when a dirty script block is removed', () => {
        assert.strictEqual(lens(SCRIPT, true).command?.command, SETUP_COMMAND);
        const changed = sinon.spy();
        provider.onDidChangeCodeLenses(changed);
        const plain = 'print("hello")\n';

        fireChange(plain, 0, SCRIPT.length, plain);

        sinon.assert.calledOnce(changed);
        assert.deepStrictEqual(provider.provideCodeLenses(document(plain, true), {} as never), []);
    });

    test('offers setup for a newly typed block before detection or saving', () => {
        const result = lens(SCRIPT, true);
        assert.strictEqual(result.command?.command, SETUP_COMMAND);
        assert.deepStrictEqual(result.command?.arguments, [scriptUri]);
        assert.strictEqual(routing.getMetadata(scriptUri), undefined, 'presentation must not seed saved routing');
    });

    for (const text of [
        '# /// script',
        '# /// script\n# dependencies = [',
        '# /// script\n# dependencies = ["requests",]\nnot_a_comment\n# ///',
        '# /// script\n# dependencies = 1\n# ///',
        '# /// script \n# dependencies = []\n# /// ',
        '  # /// script\n# broken TOML\n# ///',
    ]) {
        test(`keeps setup available for malformed metadata: ${JSON.stringify(text)}`, () => {
            assert.strictEqual(lens(text, true).command?.command, SETUP_COMMAND);
            assert.strictEqual(lens(text).command?.command, SETUP_COMMAND);
        });
    }

    test('always shows the ready interpreter for a validated unchanged block', () => {
        ready();
        assert.strictEqual(lens().command?.title, 'Script environment ready (Python 3.12.4)');
        assert.strictEqual(lens().command?.command, '');
    });

    test('does not expire the ready label', () => {
        const clock = sinon.useFakeTimers();
        ready();
        clock.tick(60_000);
        assert.strictEqual(lens().command?.title, 'Script environment ready (Python 3.12.4)');
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('shows the ready label when the association was restored before the provider was created', () => {
        provider.dispose();
        ready(SCRIPT, '3.13.2.final.0');
        provider = new InlineScriptCodeLensProvider(routing, SETUP_COMMAND);
        assert.strictEqual(lens().command?.title, 'Script environment ready (Python 3.13.2)');
    });

    test('omits an unknown interpreter version without hiding the ready label', () => {
        ready(SCRIPT, '');
        assert.strictEqual(lens().command?.title, 'Script environment ready');
    });

    test('keeps ready visible during unsaved body-only edits', () => {
        ready();
        assert.strictEqual(lens(SCRIPT.replace('hello', 'changed body'), true).command?.command, '');
    });

    test('offers setup immediately for raw block edits even before routing catches up', () => {
        ready();
        assert.strictEqual(lens(SCRIPT.replace('requests', 'Requests'), true).command?.command, SETUP_COMMAND);
        assert.strictEqual(routing.shouldRoute(scriptUri), true, 'the lens must not change interpreter routing');
    });

    test('keeps setup visible after the detector clears dirty metadata', () => {
        ready();
        routing.clearMetadata(scriptUri);
        routing.setValidatedAssociation(scriptUri, false);
        assert.strictEqual(lens(SCRIPT.replace('"requests"', '"requests'), true).command?.command, SETUP_COMMAND);
    });

    test('returns to ready after unchanged requirements are saved and revalidated', () => {
        ready();
        const edited = SCRIPT.replace('requests', 'Requests');
        assert.strictEqual(lens(edited, true).command?.command, SETUP_COMMAND);
        ready(edited);
        assert.strictEqual(lens(edited).command?.command, '');
    });

    test('does not show ready for an additional unsaved script block', () => {
        ready();
        assert.strictEqual(lens(`${SCRIPT}\n# /// script\n# ///`, true).command?.command, SETUP_COMMAND);
    });

    for (const invalid of [
        `${SCRIPT}\n# /// script\n#bad`,
        SCRIPT.replace('["requests"]', '["requests", ""]'),
        SCRIPT.replace('# dependencies', '# requires-python = "invalid"\n# dependencies'),
    ]) {
        test(`keeps setup after malformed metadata is saved over a ready association: ${JSON.stringify(invalid)}`, () => {
            ready();
            const parsed = readInlineScriptMetadata(invalid);
            assert.ok(parsed, 'the tolerant parser intentionally retains usable metadata');
            routing.setMetadata(scriptUri, parsed);
            routing.setValidatedAssociation(scriptUri, true, '3.12.4');
            assert.strictEqual(lens(invalid).command?.command, SETUP_COMMAND);
        });
    }

    test('shows ready when the editor normalizes saved mixed line endings', () => {
        const disk = '# /// script\r\n# dependencies = ["requests"]\n# ///\rprint("hello")';
        ready(disk);
        assert.strictEqual(lens(disk.replace(/\r\n?/g, '\n')).command?.command, '');
    });

    test('offers setup if a preceding non-script opener hides the previously validated block', () => {
        const original = `# note\n${SCRIPT}`;
        ready(original);
        assert.strictEqual(lens(original.replace('# note', '# /// other'), true).command?.command, SETUP_COMMAND);
    });

    test('keeps ready for body edits following an ignored metadata example', () => {
        const original = `${SCRIPT}\n"""\n# /// script\n# dependencies = ["example"]\n"""\nprint("body")`;
        ready(original);
        assert.strictEqual(lens(original.replace('"body"', '"changed"'), true).command?.command, '');
    });

    test('keeps a lens when the closing marker is removed', () => {
        ready();
        assert.strictEqual(lens(SCRIPT.replace('# ///\n', ''), true).command?.command, SETUP_COMMAND);
    });

    test('removes the lens when the script block is removed', () => {
        ready();
        assert.deepStrictEqual(provider.provideCodeLenses(document('print("hello")', true), {} as never), []);
    });

    test('anchors the lens to the live marker with BOM and CRLF', () => {
        const text = `\uFEFF#!/usr/bin/env python\r\n${SCRIPT.replace(/\n/g, '\r\n')}`;
        ready(text);
        const result = lens(text);
        assert.strictEqual(result.range.start.line, 1);
        assert.strictEqual(result.range.start.character, 0);
        assert.strictEqual(result.command?.command, '');
    });

    test('offers retry during temporary unavailability and restores ready on recovery', () => {
        ready();
        routing.setEnvironmentUnavailable(scriptUri, true);
        assert.strictEqual(lens().command?.command, SETUP_COMMAND);
        routing.setEnvironmentUnavailable(scriptUri, false);
        assert.strictEqual(lens().command?.title, 'Script environment ready (Python 3.12.4)');
    });

    test('offers setup after an environment is invalidated', () => {
        ready();
        routing.setValidatedAssociation(scriptUri, false);
        assert.strictEqual(lens().command?.command, SETUP_COMMAND);
    });

    test('keeps two scripts and their interpreter versions independent', () => {
        const other = Uri.file(path.join(process.cwd(), 'lens-tests', 'other.py'));
        ready();
        ready(SCRIPT, '3.11.9', other);
        assert.strictEqual(lens().command?.title, 'Script environment ready (Python 3.12.4)');
        assert.strictEqual(lens(SCRIPT, true, other).command?.title, 'Script environment ready (Python 3.11.9)');
    });

    test('refreshes when a validated interpreter version changes without a routeability change', () => {
        ready();
        const changed = sinon.spy();
        provider.onDidChangeCodeLenses(changed);
        routing.setValidatedAssociation(scriptUri, true, '3.13.1');
        sinon.assert.calledOnce(changed);
        assert.strictEqual(lens().command?.title, 'Script environment ready (Python 3.13.1)');
    });

    test('does not decorate resources unsupported by inline setup', () => {
        for (const uri of [Uri.parse('untitled:app.py'), scriptUri.with({ path: `${scriptUri.path}i` })]) {
            assert.deepStrictEqual(provider.provideCodeLenses(document(SCRIPT, false, uri), {} as never), []);
        }
        assert.deepStrictEqual(
            provider.provideCodeLenses(document(`${'# padding\n'.repeat(MAX_HEADER_BYTES)}${SCRIPT}`), {} as never),
            [],
        );
    });

    test('stops publishing after disposal', () => {
        const changed = sinon.spy();
        provider.onDidChangeCodeLenses(changed);
        provider.dispose();
        ready();
        sinon.assert.notCalled(changed);
        assert.deepStrictEqual(provider.provideCodeLenses(document(), {} as never), []);
    });
});
