// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typmoq from 'typemoq';
import { ConfigurationChangeEvent, Disposable, TextDocument, Uri } from 'vscode';
import { PythonProject } from '../../api';
import * as ism from '../../common/inlineScriptMetadata';
import * as wapi from '../../common/workspace.apis';
import { InlineScriptLazyDetector, shouldHandleUri } from '../../features/inlineScriptLazyDetector';
import { PythonProjectManager, PythonProjectsImpl } from '../../internal.api';

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
    let onDidChangeConfigStub: sinon.SinonStub;
    let getOpenTextDocumentsStub: sinon.SinonStub;
    let getWorkspaceFolderStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let isEnabledStub: sinon.SinonStub;
    let openListener: ((doc: TextDocument) => unknown) | undefined;
    let saveListener: ((doc: TextDocument) => unknown) | undefined;
    let configListener: ((e: ConfigurationChangeEvent) => unknown) | undefined;
    let projectManager: typmoq.IMock<PythonProjectManager>;

    setup(() => {
        openListener = undefined;
        saveListener = undefined;
        configListener = undefined;

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

        onDidChangeConfigStub = sinon.stub(wapi, 'onDidChangeConfiguration');
        onDidChangeConfigStub.callsFake((listener: (e: ConfigurationChangeEvent) => unknown) => {
            configListener = listener;
            return new Disposable(() => {
                configListener = undefined;
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

        isEnabledStub = sinon.stub(ism, 'isInlineScriptMetadataEnabled');
        isEnabledStub.returns(true);

        projectManager = typmoq.Mock.ofType<PythonProjectManager>();
        projectManager.setup((pm) => pm.add(typmoq.It.isAny())).returns(() => Promise.resolve());
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
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        assert.ok(onDidOpenStub.calledOnce, 'should subscribe to onDidOpenTextDocument');
        assert.ok(onDidSaveStub.calledOnce, 'should subscribe to onDidSaveTextDocument');
        detector.dispose();
    });

    test('skips non-file URI schemes', async () => {
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(Uri.parse('untitled:foo.py'));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-file URI');
        detector.dispose();
    });

    test('skips non-.py files', async () => {
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(Uri.file(path.resolve('/ws/foo.txt')));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-.py files');
        detector.dispose();
    });

    test('skips files outside any workspace folder', async () => {
        getWorkspaceFolderStub.returns(undefined);
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(Uri.file(path.resolve('/elsewhere/foo.py')));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for out-of-workspace files');
        detector.dispose();
    });

    test('no-op when feature is disabled', async () => {
        isEnabledStub.returns(false);
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(Uri.file(path.resolve('/ws/foo.py')));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata when setting is disabled');
        detector.dispose();
    });

    test('registers a new project when a .py file with metadata is opened', async () => {
        const uri = Uri.file(path.resolve('/ws/foo.py'));
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.reset();
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);
        let captured: PythonProject | PythonProject[] | undefined;
        projectManager
            .setup((pm) => pm.add(typmoq.It.isAny()))
            .callback((arg: PythonProject | PythonProject[]) => {
                captured = arg;
            })
            .returns(() => Promise.resolve());

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(uri);

        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.once());
        assert.ok(captured, 'pm.add should have been called with a project');
        assert.ok(!Array.isArray(captured), 'expected a single project, not an array');
        const project = captured as PythonProjectsImpl;
        assert.ok(project instanceof PythonProjectsImpl, 'project should be a PythonProjectsImpl');
        assert.strictEqual(project.uri.toString(), uri.toString());
        assert.deepStrictEqual(project.inlineScriptMetadata, VALID_METADATA);
        detector.dispose();
    });

    test('save event also registers a new project', async () => {
        const uri = Uri.file(path.resolve('/ws/bar.py'));
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireSave(uri);

        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.once());
        detector.dispose();
    });

    test('does not register a project when there is no metadata', async () => {
        readMetadataStub.resolves(undefined);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(Uri.file(path.resolve('/ws/plain.py')));

        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.never());
        detector.dispose();
    });

    test('refreshes metadata on save when the project is already registered', async () => {
        const uri = Uri.file(path.resolve('/ws/already.py'));
        const existing = new PythonProjectsImpl('already.py', uri);
        existing.inlineScriptMetadata = {
            requiresPython: '>=3.10',
            dependencies: ['old'],
            tool: undefined,
            range: { start: 0, end: 20 },
        };
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => existing);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireSave(uri);

        // No add() call: the project is already registered.
        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.never());
        assert.deepStrictEqual(existing.inlineScriptMetadata, VALID_METADATA, 'metadata should be refreshed');
        detector.dispose();
    });

    test('clears cached metadata when a save removes the block from a known project', async () => {
        const uri = Uri.file(path.resolve('/ws/wasScript.py'));
        const existing = new PythonProjectsImpl('wasScript.py', uri);
        existing.inlineScriptMetadata = VALID_METADATA;
        readMetadataStub.resolves(undefined);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => existing);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireSave(uri);

        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.never());
        assert.strictEqual(existing.inlineScriptMetadata, undefined, 'metadata cache should be cleared');
        detector.dispose();
    });

    test('coalesces concurrent open + save for the same URI', async () => {
        const uri = Uri.file(path.resolve('/ws/race.py'));
        // First call resolves with metadata, second would too if it
        // were made — but we expect coalescing to avoid the second
        // call entirely.
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await Promise.all([fireOpen(uri), fireSave(uri)]);

        // The read may still be invoked once for the leading event;
        // the second is coalesced.
        assert.ok(readMetadataStub.callCount === 1, `expected exactly one read, got ${readMetadataStub.callCount}`);
        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.once());
        detector.dispose();
    });

    // ---------- B1 / B2: catch-up replay over `getOpenTextDocuments` ----------

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
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);
        getOpenTextDocumentsStub.returns([makeDoc(uriWithMeta), makeDoc(uriPlain), makeDoc(uriNonPy)]);

        const detector = new InlineScriptLazyDetector(projectManager.object);
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
        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.once());
        detector.dispose();
    });

    test('dispose() cancels the pending catch-up replay', async () => {
        getOpenTextDocumentsStub.returns([makeDoc(Uri.file(path.resolve('/ws/never.py')))]);
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        // Tear down BEFORE the `setImmediate` slot fires.
        detector.dispose();
        await flushImmediate();
        assert.ok(readMetadataStub.notCalled, 'dispose() must clear the pending setImmediate handle');
    });

    // ---------- B3: URI registered with a non-impl project ----------

    test('skips refresh when URI is registered with a non-PythonProjectsImpl project', async () => {
        const uri = Uri.file(path.resolve('/ws/foreign.py'));
        // A `PythonProject` that is NOT a `PythonProjectsImpl`. This
        // mirrors the (rare) case where a third-party manager has
        // registered the same URI under its own concrete class.
        const foreign: PythonProject = { name: 'foreign.py', uri };
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => foreign);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(uri);

        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.never());
        detector.dispose();
    });

    // ---------- B6: multi-root per-folder gating ----------

    test('respects per-folder setting scope when the feature is enabled in some folders only', async () => {
        const onUri = Uri.file(path.resolve('/wsOn/script.py'));
        const offUri = Uri.file(path.resolve('/wsOff/script.py'));
        // Stub the gate so it returns true only for URIs that look
        // like they live under `/wsOn`.
        isEnabledStub.callsFake((scope?: { fsPath?: string }) => {
            const p = scope?.fsPath;
            if (typeof p !== 'string') {
                return false;
            }
            return p.includes(`${path.sep}wsOn${path.sep}`) || p.endsWith(`${path.sep}wsOn`);
        });
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await fireOpen(onUri);
        await fireOpen(offUri);

        assert.strictEqual(readMetadataStub.callCount, 1, 'should read only the file in the enabled folder');
        const readUri = readMetadataStub.firstCall.args[0] as Uri;
        assert.strictEqual(readUri.toString(), onUri.toString());
        detector.dispose();
    });

    // ---------- C2: setting-toggle triggers replay ----------

    test('onDidChangeConfiguration replays open documents when the experimental setting toggles', async () => {
        const uri = Uri.file(path.resolve('/ws/late.py'));
        // The file is open in the editor BEFORE the user toggles the
        // setting. The activation replay finds it but bails because
        // the feature is disabled.
        getOpenTextDocumentsStub.returns([makeDoc(uri)]);
        isEnabledStub.returns(false);
        readMetadataStub.resolves(VALID_METADATA);
        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await flushImmediate();
        assert.ok(readMetadataStub.notCalled, 'replay during activation should bail because setting is off');

        // User flips the setting on; the lazy detector should pick
        // the file up without requiring a manual save or reload.
        isEnabledStub.returns(true);
        assert.ok(configListener, 'config-change listener should be registered after activate()');
        const event = {
            affectsConfiguration: (key: string) => key === 'python-envs.useInlineScriptMetadata',
        } as ConfigurationChangeEvent;
        configListener!(event);
        // The replay schedules `handleDocument` synchronously; let
        // the awaited work resolve.
        await flushImmediate();
        await flushImmediate();

        assert.strictEqual(readMetadataStub.callCount, 1, 'config-change replay must inspect the open .py document');
        projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.once());
        detector.dispose();
    });

    test('onDidChangeConfiguration ignores changes to unrelated settings', async () => {
        getOpenTextDocumentsStub.returns([makeDoc(Uri.file(path.resolve('/ws/foo.py')))]);
        const detector = new InlineScriptLazyDetector(projectManager.object);
        detector.activate();
        await flushImmediate();
        // The activation replay invoked `handleDocument` and bailed
        // inside the gate (read stub returned undefined). Reset.
        readMetadataStub.resetHistory();

        const event = {
            affectsConfiguration: (_key: string) => false,
        } as ConfigurationChangeEvent;
        assert.ok(configListener);
        configListener!(event);
        await flushImmediate();
        assert.ok(readMetadataStub.notCalled, 'unrelated config change must not trigger a replay');
        detector.dispose();
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
