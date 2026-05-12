// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typmoq from 'typemoq';
import { Disposable, TextDocument, Uri } from 'vscode';
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
    let getWorkspaceFolderStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let isEnabledStub: sinon.SinonStub;
    let openListener: ((doc: TextDocument) => unknown) | undefined;
    let saveListener: ((doc: TextDocument) => unknown) | undefined;
    let projectManager: typmoq.IMock<PythonProjectManager>;

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
