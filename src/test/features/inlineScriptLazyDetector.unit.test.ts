// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, TextDocument, Uri } from 'vscode';
import * as ism from '../../common/inlineScriptMetadata';
import * as wapi from '../../common/workspace.apis';
import { InlineScriptLazyDetector, shouldHandleUri } from '../../features/inlineScriptLazyDetector';

// Build a minimal TextDocument stub. Only the `uri` field is read by
// the detector; the rest exists to satisfy the type.
function makeDoc(uri: Uri): TextDocument {
    return { uri } as TextDocument;
}

const VALID_METADATA: ism.InlineScriptMetadata = {
    requiresPython: '>=3.11',
    dependencies: ['requests'],
    tool: undefined,
    range: { start: 0, end: 40 },
};

suite('InlineScriptLazyDetector', () => {
    let onDidOpenStub: sinon.SinonStub;
    let onDidSaveStub: sinon.SinonStub;
    let getOpenTextDocumentsStub: sinon.SinonStub;
    let getWorkspaceFolderStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let openListener: ((doc: TextDocument) => unknown) | undefined;
    let saveListener: ((doc: TextDocument) => unknown) | undefined;

    setup(() => {
        openListener = undefined;
        saveListener = undefined;

        onDidOpenStub = sinon.stub(wapi, 'onDidOpenTextDocument');
        onDidOpenStub.callsFake((listener: (doc: TextDocument) => unknown) => {
            openListener = listener;
            return new Disposable(() => {
                openListener = undefined;
            });
        });

        onDidSaveStub = sinon.stub(wapi, 'onDidSaveTextDocument');
        onDidSaveStub.callsFake((listener: (doc: TextDocument) => unknown) => {
            saveListener = listener;
            return new Disposable(() => {
                saveListener = undefined;
            });
        });

        // Default to an empty list of open documents. Tests that
        // exercise the catch-up replay override this.
        getOpenTextDocumentsStub = sinon.stub(wapi, 'getOpenTextDocuments');
        getOpenTextDocumentsStub.returns([]);

        getWorkspaceFolderStub = sinon.stub(wapi, 'getWorkspaceFolder');
        // By default, every URI is treated as being inside a workspace
        // folder. Tests that want to exercise the "not in workspace"
        // branch override this.
        getWorkspaceFolderStub.callsFake((uri: Uri) => ({
            uri: Uri.file(path.dirname(uri.fsPath)),
            name: 'mockWorkspace',
            index: 0,
        }));

        readMetadataStub = sinon.stub(ism, 'readInlineScriptMetadataFromFile');
        readMetadataStub.resolves(undefined);
    });

    teardown(() => {
        sinon.restore();
    });

    async function fireOpen(uri: Uri): Promise<void> {
        assert.ok(openListener, 'open listener should be registered after activate()');
        await openListener!(makeDoc(uri));
    }

    async function fireSave(uri: Uri): Promise<void> {
        assert.ok(saveListener, 'save listener should be registered after activate()');
        await saveListener!(makeDoc(uri));
    }

    test('activate() subscribes to onDidOpen and onDidSave', () => {
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        assert.ok(onDidOpenStub.calledOnce, 'should subscribe to onDidOpenTextDocument');
        assert.ok(onDidSaveStub.calledOnce, 'should subscribe to onDidSaveTextDocument');
        detector.dispose();
    });

    test('skips non-file URI schemes', async () => {
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await fireOpen(Uri.parse('untitled:foo.py'));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-file URI');
        detector.dispose();
    });

    test('skips non-.py files', async () => {
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await fireOpen(Uri.file(path.resolve('/ws/foo.txt')));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-.py files');
        detector.dispose();
    });

    test('skips files outside any workspace folder', async () => {
        getWorkspaceFolderStub.returns(undefined);
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await fireOpen(Uri.file(path.resolve('/elsewhere/foo.py')));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for out-of-workspace files');
        detector.dispose();
    });

    test('reads metadata for an in-workspace .py file on open', async () => {
        const uri = Uri.file(path.resolve('/ws/foo.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await fireOpen(uri);
        assert.strictEqual(readMetadataStub.callCount, 1, 'open should trigger exactly one read');
        assert.strictEqual((readMetadataStub.firstCall.args[0] as Uri).toString(), uri.toString());
        detector.dispose();
    });

    test('reads metadata for an in-workspace .py file on save', async () => {
        const uri = Uri.file(path.resolve('/ws/bar.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await fireSave(uri);
        assert.strictEqual(readMetadataStub.callCount, 1, 'save should trigger exactly one read');
        detector.dispose();
    });

    test('concurrent open + open coalesces to a single read', async () => {
        const uri = Uri.file(path.resolve('/ws/dedup.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await Promise.all([fireOpen(uri), fireOpen(uri)]);
        assert.strictEqual(readMetadataStub.callCount, 1, 'open+open should coalesce to a single read');
        detector.dispose();
    });

    test('concurrent open + save coalesces to a single read', async () => {
        const uri = Uri.file(path.resolve('/ws/race.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        await Promise.all([fireOpen(uri), fireSave(uri)]);
        // The slim observer has no cached state to keep fresh, so
        // simple URI-level dedup is sufficient: a save concurrent
        // with an in-flight open coalesces with it.
        assert.strictEqual(readMetadataStub.callCount, 1, 'concurrent open+save should coalesce to a single read');
        detector.dispose();
    });

    test('dispose() during an in-flight read bails out before logging detection', async () => {
        const uri = Uri.file(path.resolve('/ws/disposed.py'));
        let resolveRead: ((meta: ism.InlineScriptMetadata) => void) | undefined;
        readMetadataStub.returns(
            new Promise<ism.InlineScriptMetadata>((resolve) => {
                resolveRead = resolve;
            }),
        );

        const detector = new InlineScriptLazyDetector();
        detector.activate();
        // Kick off the open without awaiting it; the read is parked
        // on our manual resolver above.
        const inFlight = openListener!(makeDoc(uri)) as Promise<void> | undefined;
        // Tear the detector down BEFORE the read settles.
        detector.dispose();
        // Now let the in-flight read complete with metadata. The
        // `disposed` guard inside processOnce should prevent any
        // further work (in the future, this guard also protects the
        // telemetry emission site from firing after disposal).
        resolveRead!(VALID_METADATA);
        await assert.doesNotReject(inFlight ?? Promise.resolve());
    });

    // ---------- catch-up replay over `getOpenTextDocuments` ----------

    // Drain the microtask queue and the next `setImmediate` slot so
    // the deferred catch-up replay can run before assertions.
    function flushImmediate(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    test('activate() replays already-open .py documents via setImmediate', async () => {
        const uriWithMeta = Uri.file(path.resolve('/ws/withMeta.py'));
        const uriPlain = Uri.file(path.resolve('/ws/plain.py'));
        const uriNonPy = Uri.file(path.resolve('/ws/skip.txt'));
        readMetadataStub.callsFake(async (u: Uri) =>
            u.toString() === uriWithMeta.toString() ? VALID_METADATA : undefined,
        );
        getOpenTextDocumentsStub.returns([makeDoc(uriWithMeta), makeDoc(uriPlain), makeDoc(uriNonPy)]);

        const detector = new InlineScriptLazyDetector();
        detector.activate();
        // Wait for the deferred catch-up.
        await flushImmediate();
        // Then await any in-flight reads kicked off by the replay.
        await flushImmediate();

        // The non-`.py` URI must be filtered out by `shouldHandleUri`
        // BEFORE the read is attempted.
        assert.strictEqual(readMetadataStub.callCount, 2, 'should read each candidate .py document exactly once');
        const readUris = readMetadataStub.getCalls().map((c) => (c.args[0] as Uri).toString());
        assert.ok(readUris.includes(uriWithMeta.toString()));
        assert.ok(readUris.includes(uriPlain.toString()));
        assert.ok(!readUris.includes(uriNonPy.toString()), 'should not read non-.py URI during replay');
        detector.dispose();
    });

    test('dispose() cancels the pending catch-up replay', async () => {
        getOpenTextDocumentsStub.returns([makeDoc(Uri.file(path.resolve('/ws/never.py')))]);
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        // Tear down BEFORE the `setImmediate` slot fires.
        detector.dispose();
        await flushImmediate();
        assert.ok(readMetadataStub.notCalled, 'dispose() must clear the pending setImmediate handle');
    });
});

suite('shouldHandleUri', () => {
    let getWorkspaceFolderStub: sinon.SinonStub;

    setup(() => {
        getWorkspaceFolderStub = sinon.stub(wapi, 'getWorkspaceFolder');
        getWorkspaceFolderStub.callsFake((uri: Uri) => ({
            uri: Uri.file(path.dirname(uri.fsPath)),
            name: 'ws',
            index: 0,
        }));
    });

    teardown(() => {
        sinon.restore();
    });

    test('accepts .py file in workspace folder', () => {
        assert.strictEqual(shouldHandleUri(Uri.file(path.resolve('/ws/a.py'))), true);
    });

    test('accepts .PY (uppercase) file', () => {
        assert.strictEqual(shouldHandleUri(Uri.file(path.resolve('/ws/A.PY'))), true);
    });

    test('rejects non-.py extension', () => {
        assert.strictEqual(shouldHandleUri(Uri.file(path.resolve('/ws/a.txt'))), false);
    });

    test('rejects non-file scheme', () => {
        assert.strictEqual(shouldHandleUri(Uri.parse('untitled:a.py')), false);
    });

    test('rejects file outside any workspace folder', () => {
        getWorkspaceFolderStub.returns(undefined);
        assert.strictEqual(shouldHandleUri(Uri.file(path.resolve('/elsewhere/a.py'))), false);
    });
});
