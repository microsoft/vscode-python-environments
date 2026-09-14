// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import {
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Disposable,
    Position,
    TextDocument,
    TextDocumentChangeEvent,
    Uri,
} from 'vscode';
import * as logging from '../../../common/logging';
import * as wapi from '../../../common/workspace.apis';
import { InlineScriptDiagnosticsPublisher, shouldValidateUri } from '../../../features/inlineScript/diagnostics';

const DEBOUNCE_MS = 300;

const BROKEN_SCRIPT = ['# /// script', '# dependencies = ["requests"]', 'print("hi")'].join('\n');
const VALID_SCRIPT = ['# /// script', '# dependencies = ["requests"]', '# ///', 'print("hi")'].join('\n');
const PLAIN_SCRIPT = 'print("hi")\n';

function makeDoc(uri: Uri, text: string): TextDocument {
    return {
        uri,
        getText: () => text,
        positionAt: (offset: number) => new Position(0, offset),
    } as unknown as TextDocument;
}

function makeCollection() {
    const entries = new Map<string, readonly Diagnostic[]>();
    let disposed = false;
    const collection = {
        set: (uri: Uri, diagnostics: readonly Diagnostic[]) => entries.set(uri.toString(), diagnostics),
        delete: (uri: Uri) => entries.delete(uri.toString()),
        clear: () => entries.clear(),
        dispose: () => {
            disposed = true;
            entries.clear();
        },
    } as unknown as DiagnosticCollection;
    return {
        collection,
        entries,
        get disposed() {
            return disposed;
        },
        for(uri: Uri): readonly Diagnostic[] | undefined {
            return entries.get(uri.toString());
        },
    };
}

suite('InlineScriptDiagnosticsPublisher', () => {
    const scriptUri = Uri.file('/workspace/app.py');
    const otherUri = Uri.file('/workspace/other.py');

    let clock: sinon.SinonFakeTimers;
    let sink: ReturnType<typeof makeCollection>;
    let publisher: InlineScriptDiagnosticsPublisher;
    let openDocs: TextDocument[];

    let openListener: ((doc: TextDocument) => unknown) | undefined;
    let saveListener: ((doc: TextDocument) => unknown) | undefined;
    let changeListener: ((e: TextDocumentChangeEvent) => unknown) | undefined;
    let closeListener: ((doc: TextDocument) => unknown) | undefined;
    let deleteListener: ((e: { files: readonly Uri[] }) => unknown) | undefined;
    let renameListener: ((e: { files: readonly { oldUri: Uri; newUri: Uri }[] }) => unknown) | undefined;

    function captureListener<T>(assign: (listener: T) => void) {
        return (listener: T) => {
            assign(listener);
            return new Disposable(() => undefined);
        };
    }

    setup(() => {
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceVerbose');

        openListener = undefined;
        saveListener = undefined;
        changeListener = undefined;
        closeListener = undefined;
        deleteListener = undefined;
        renameListener = undefined;
        openDocs = [];

        sinon.stub(wapi, 'onDidOpenTextDocument').callsFake(captureListener((l) => (openListener = l)));
        sinon.stub(wapi, 'onDidSaveTextDocument').callsFake(captureListener((l) => (saveListener = l)));
        sinon.stub(wapi, 'onDidChangeTextDocument').callsFake(captureListener((l) => (changeListener = l)));
        sinon.stub(wapi, 'onDidCloseTextDocument').callsFake(captureListener((l) => (closeListener = l)));
        sinon.stub(wapi, 'onDidDeleteFiles').callsFake(captureListener((l) => (deleteListener = l)));
        sinon.stub(wapi, 'onDidRenameFiles').callsFake(captureListener((l) => (renameListener = l)));
        sinon.stub(wapi, 'getOpenTextDocuments').callsFake(() => openDocs);

        sink = makeCollection();
        publisher = new InlineScriptDiagnosticsPublisher(sink.collection);
        publisher.activate();
    });

    teardown(() => {
        publisher.dispose();
        clock.restore();
        sinon.restore();
    });

    function change(doc: TextDocument): void {
        changeListener?.({ document: doc, contentChanges: [], reason: undefined } as TextDocumentChangeEvent);
    }

    suite('publishing', () => {
        test('a malformed block produces a diagnostic on open', () => {
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));

            const published = sink.for(scriptUri);
            assert.ok(published, 'expected diagnostics to be published');
            assert.strictEqual(published!.length, 1);
            assert.strictEqual(published![0].code, 'unterminated-block');
            assert.strictEqual(published![0].severity, DiagnosticSeverity.Warning);
            assert.ok(published![0].message.length > 0, 'expected a localized message');
        });

        test('spec violations are published as errors', () => {
            openListener?.(makeDoc(scriptUri, ['# /// script', '#bad', '# ///'].join('\n')));

            const published = sink.for(scriptUri);
            assert.strictEqual(published![0].severity, DiagnosticSeverity.Error);
            assert.strictEqual(published![0].code, 'invalid-content-line');
        });

        test('a well-formed block publishes nothing', () => {
            openListener?.(makeDoc(scriptUri, VALID_SCRIPT));
            assert.strictEqual(sink.for(scriptUri), undefined);
        });

        test('a file with no block publishes nothing', () => {
            openListener?.(makeDoc(scriptUri, PLAIN_SCRIPT));
            assert.strictEqual(sink.for(scriptUri), undefined);
        });

        test('fixing the block removes the diagnostic', () => {
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));
            assert.ok(sink.for(scriptUri), 'expected an initial diagnostic');

            saveListener?.(makeDoc(scriptUri, VALID_SCRIPT));
            assert.strictEqual(sink.for(scriptUri), undefined, 'diagnostic should be cleared once valid');
        });

        test('non-Python and non-file documents are ignored', () => {
            const notPython = Uri.file('/workspace/notes.txt');
            const untitled = Uri.parse('untitled:Untitled-1');

            openListener?.(makeDoc(notPython, BROKEN_SCRIPT));
            openListener?.(makeDoc(untitled, BROKEN_SCRIPT));

            assert.strictEqual(sink.entries.size, 0);
            assert.strictEqual(shouldValidateUri(notPython), false);
            assert.strictEqual(shouldValidateUri(untitled), false);
        });

        test('validation reads the live buffer, not the file on disk', () => {
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));
            assert.ok(sink.for(scriptUri));
        });
    });

    suite('debouncing changes', () => {
        test('nothing is published until the debounce elapses', () => {
            change(makeDoc(scriptUri, BROKEN_SCRIPT));
            clock.tick(DEBOUNCE_MS - 1);
            assert.strictEqual(sink.for(scriptUri), undefined, 'should not publish mid-edit');

            clock.tick(1);
            assert.ok(sink.for(scriptUri), 'should publish once typing settles');
        });

        test('rapid edits only validate once, against the final text', () => {
            change(makeDoc(scriptUri, '# /// script'));
            clock.tick(100);
            change(makeDoc(scriptUri, '# /// script\n# dependencies = []'));
            clock.tick(100);
            change(makeDoc(scriptUri, VALID_SCRIPT));
            clock.tick(100);
            assert.strictEqual(sink.for(scriptUri), undefined, 'no intermediate squiggle should appear');

            clock.tick(DEBOUNCE_MS);
            assert.strictEqual(sink.for(scriptUri), undefined, 'final text is valid, so nothing is published');
        });

        test('each document debounces independently', () => {
            change(makeDoc(scriptUri, BROKEN_SCRIPT));
            clock.tick(DEBOUNCE_MS - 50);
            change(makeDoc(otherUri, BROKEN_SCRIPT));
            clock.tick(50);

            assert.ok(sink.for(scriptUri), 'first document should have been validated on schedule');
            assert.strictEqual(sink.for(otherUri), undefined, 'second document is still within its own debounce');

            clock.tick(DEBOUNCE_MS);
            assert.ok(sink.for(otherUri));
        });

        test('a save supersedes a queued change rather than being overwritten by it', () => {
            change(makeDoc(scriptUri, BROKEN_SCRIPT));
            saveListener?.(makeDoc(scriptUri, VALID_SCRIPT));
            assert.strictEqual(sink.for(scriptUri), undefined);

            clock.tick(DEBOUNCE_MS * 2);
            assert.strictEqual(sink.for(scriptUri), undefined, 'stale queued validation must not resurrect a squiggle');
        });
    });

    suite('clearing', () => {
        test('closing a document clears its diagnostics', () => {
            const doc = makeDoc(scriptUri, BROKEN_SCRIPT);
            openListener?.(doc);
            assert.ok(sink.for(scriptUri));

            closeListener?.(doc);
            assert.strictEqual(sink.for(scriptUri), undefined);
        });

        test('closing cancels any queued validation', () => {
            const doc = makeDoc(scriptUri, BROKEN_SCRIPT);
            change(doc);
            closeListener?.(doc);

            clock.tick(DEBOUNCE_MS * 2);
            assert.strictEqual(sink.for(scriptUri), undefined, 'a closed document must not gain a squiggle');
        });

        test('deleting a file clears its diagnostics', () => {
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));
            deleteListener?.({ files: [scriptUri] });
            assert.strictEqual(sink.for(scriptUri), undefined);
        });

        test('deleting a folder clears diagnostics for files inside it', () => {
            const nested = Uri.file('/workspace/pkg/app.py');
            openListener?.(makeDoc(nested, BROKEN_SCRIPT));
            assert.ok(sink.for(nested));

            deleteListener?.({ files: [Uri.file('/workspace/pkg')] });
            assert.strictEqual(sink.for(nested), undefined);
        });

        test('renaming clears the old path and re-validates the new one', () => {
            const renamed = Uri.file('/workspace/renamed.py');
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));
            assert.ok(sink.for(scriptUri));

            openDocs = [makeDoc(renamed, BROKEN_SCRIPT)];
            renameListener?.({ files: [{ oldUri: scriptUri, newUri: renamed }] });

            assert.strictEqual(sink.for(scriptUri), undefined, 'old path must not keep a squiggle');
            assert.ok(sink.for(renamed), 'new path should be validated');
        });

        test('renaming a file that is not open leaves nothing behind', () => {
            const renamed = Uri.file('/workspace/renamed.py');
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));

            openDocs = [];
            renameListener?.({ files: [{ oldUri: scriptUri, newUri: renamed }] });

            assert.strictEqual(sink.entries.size, 0);
        });

        test('disposing tears down the collection and stops queued work', () => {
            change(makeDoc(scriptUri, BROKEN_SCRIPT));
            publisher.dispose();

            clock.tick(DEBOUNCE_MS * 2);
            assert.strictEqual(sink.disposed, true, 'collection should be disposed');
            assert.strictEqual(sink.entries.size, 0, 'no diagnostics should survive disposal');
        });

        test('events arriving after disposal are ignored', () => {
            publisher.dispose();
            openListener?.(makeDoc(scriptUri, BROKEN_SCRIPT));
            assert.strictEqual(sink.entries.size, 0);
        });
    });

    suite('activation replay', () => {
        test('documents already open at activation are validated', async () => {
            publisher.dispose();
            sink = makeCollection();
            openDocs = [makeDoc(scriptUri, BROKEN_SCRIPT), makeDoc(otherUri, VALID_SCRIPT)];

            publisher = new InlineScriptDiagnosticsPublisher(sink.collection);
            publisher.activate();
            await new Promise((resolve) => setImmediate(resolve));

            assert.ok(sink.for(scriptUri), 'malformed open document should be validated');
            assert.strictEqual(sink.for(otherUri), undefined, 'valid open document should stay clean');
        });

        test('the replay is cancelled if the publisher is disposed first', async () => {
            publisher.dispose();
            sink = makeCollection();
            openDocs = [makeDoc(scriptUri, BROKEN_SCRIPT)];

            publisher = new InlineScriptDiagnosticsPublisher(sink.collection);
            publisher.activate();
            publisher.dispose();
            await new Promise((resolve) => setImmediate(resolve));

            assert.strictEqual(sink.entries.size, 0);
        });
    });
});
