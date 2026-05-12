// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typmoq from 'typemoq';
import { Uri } from 'vscode';
import { PythonProject } from '../../../api';
import * as ism from '../../../common/inlineScriptMetadata';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import { InlineScriptDetector, scanForInlineScripts } from '../../../features/creators/inlineScriptDetector';
import { PythonProjectManager, PythonProjectsImpl } from '../../../internal.api';

const META_A: ism.InlineScriptMetadata = {
    requiresPython: '>=3.11',
    dependencies: ['requests'],
    tool: undefined,
    range: { start: 0, end: 40 },
};
const META_B: ism.InlineScriptMetadata = {
    requiresPython: '>=3.10',
    dependencies: ['rich'],
    tool: undefined,
    range: { start: 0, end: 40 },
};

suite('InlineScriptDetector (creator)', () => {
    let findFilesStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;
    let showErrorStub: sinon.SinonStub;
    let showQuickPickStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let isEnabledStub: sinon.SinonStub;
    let pm: typmoq.IMock<PythonProjectManager>;

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles');
        findFilesStub.resolves([]);

        getWorkspaceFoldersStub = sinon.stub(wapi, 'getWorkspaceFolders');
        // Default: no workspace folders open. Multi-root tests
        // override this.
        getWorkspaceFoldersStub.returns(undefined);

        showErrorStub = sinon.stub(winapi, 'showErrorMessage');
        showErrorStub.resolves(undefined);

        showQuickPickStub = sinon.stub(winapi, 'showQuickPickWithButtons');
        showQuickPickStub.resolves(undefined);

        readMetadataStub = sinon.stub(ism, 'readInlineScriptMetadataFromFile');
        readMetadataStub.resolves(undefined);

        isEnabledStub = sinon.stub(ism, 'isInlineScriptMetadataEnabled');
        isEnabledStub.returns(true);

        pm = typmoq.Mock.ofType<PythonProjectManager>();
        pm.setup((p) => p.get(typmoq.It.isAny())).returns(() => undefined);
        pm.setup((p) => p.add(typmoq.It.isAny())).returns(() => Promise.resolve());
    });

    teardown(() => {
        sinon.restore();
    });

    // Helper to wait for the `setImmediate`-scheduled error toast.
    function waitForImmediate(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    test('returns undefined and shows error when feature is disabled', async () => {
        isEnabledStub.returns(false);
        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        await waitForImmediate();
        assert.strictEqual(result, undefined);
        assert.ok(findFilesStub.notCalled, 'should not scan when feature is disabled');
        assert.ok(showErrorStub.calledOnce, 'should show "no scripts found" error');
    });

    test('returns undefined when findFiles returns no candidates', async () => {
        findFilesStub.resolves([]);
        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        await waitForImmediate();
        assert.strictEqual(result, undefined);
        assert.ok(showErrorStub.calledOnce);
    });

    test('returns undefined when every candidate is already registered with the same URI', async () => {
        const uri = Uri.file(path.resolve('/ws/a.py'));
        findFilesStub.resolves([uri]);
        pm.reset();
        pm.setup((p) => p.get(typmoq.It.isAny())).returns(() => ({ name: 'a.py', uri }));
        pm.setup((p) => p.add(typmoq.It.isAny())).returns(() => Promise.resolve());

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        await waitForImmediate();
        assert.strictEqual(result, undefined);
        assert.ok(readMetadataStub.notCalled, 'should not read metadata when nothing is fresh');
        assert.ok(showErrorStub.calledOnce);
    });

    test('keeps candidate when only a folder project (different URI) contains it', async () => {
        const scriptUri = Uri.file(path.resolve('/ws/a.py'));
        const folderUri = Uri.file(path.resolve('/ws'));
        findFilesStub.resolves([scriptUri]);
        pm.reset();
        pm.setup((p) => p.get(typmoq.It.isAny())).returns(() => ({ name: 'ws', uri: folderUri }));
        pm.setup((p) => p.add(typmoq.It.isAny())).returns(() => Promise.resolve());
        readMetadataStub.resolves(META_A);
        // User cancels picker → undefined, but the scan should have occurred.
        showQuickPickStub.resolves(undefined);

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        assert.strictEqual(result, undefined);
        assert.ok(readMetadataStub.calledOnce, 'should still scan the candidate');
        assert.ok(showQuickPickStub.calledOnce, 'should present picker');
    });

    test('returns undefined and shows error when no candidate has metadata', async () => {
        const uri = Uri.file(path.resolve('/ws/plain.py'));
        findFilesStub.resolves([uri]);
        readMetadataStub.resolves(undefined);

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        await waitForImmediate();
        assert.strictEqual(result, undefined);
        assert.ok(showQuickPickStub.notCalled, 'should not show picker when no metadata found');
        assert.ok(showErrorStub.calledOnce);
    });

    test('returns undefined when the user cancels the picker', async () => {
        const uri = Uri.file(path.resolve('/ws/a.py'));
        findFilesStub.resolves([uri]);
        readMetadataStub.resolves(META_A);
        showQuickPickStub.resolves(undefined);

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        assert.strictEqual(result, undefined);
        pm.verify((p) => p.add(typmoq.It.isAny()), typmoq.Times.never());
    });

    test('registers chosen projects with cached metadata', async () => {
        const uriA = Uri.file(path.resolve('/ws/a.py'));
        const uriB = Uri.file(path.resolve('/ws/b.py'));
        findFilesStub.resolves([uriA, uriB]);
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriA.toString())).resolves(META_A);
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriB.toString())).resolves(META_B);

        // Simulate user picking BOTH.
        showQuickPickStub.callsFake(async (items: Array<{ label: string; uri: Uri }>) => items);

        let captured: PythonProject | PythonProject[] | undefined;
        pm.reset();
        pm.setup((p) => p.get(typmoq.It.isAny())).returns(() => undefined);
        pm.setup((p) => p.add(typmoq.It.isAny()))
            .callback((arg: PythonProject | PythonProject[]) => {
                captured = arg;
            })
            .returns(() => Promise.resolve());

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();

        assert.ok(result && result.length === 2, 'should return both projects');
        const sorted = [...result!].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
        const projA = sorted[0] as PythonProjectsImpl;
        const projB = sorted[1] as PythonProjectsImpl;
        assert.ok(projA instanceof PythonProjectsImpl);
        assert.ok(projB instanceof PythonProjectsImpl);
        assert.deepStrictEqual(projA.inlineScriptMetadata, META_A);
        assert.deepStrictEqual(projB.inlineScriptMetadata, META_B);
        pm.verify((p) => p.add(typmoq.It.isAny()), typmoq.Times.once());
        assert.ok(Array.isArray(captured), 'pm.add should receive an array of projects');
        assert.strictEqual((captured as PythonProject[]).length, 2);
    });

    test('handles single-item picker return (non-array) correctly', async () => {
        const uri = Uri.file(path.resolve('/ws/only.py'));
        findFilesStub.resolves([uri]);
        readMetadataStub.resolves(META_A);
        // Some VS Code wrappers return a single item rather than an
        // array even with `canPickMany: true`. Be tolerant.
        showQuickPickStub.callsFake(async (items: Array<{ label: string; uri: Uri }>) => items[0]);

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        assert.ok(result && result.length === 1);
        pm.verify((p) => p.add(typmoq.It.isAny()), typmoq.Times.once());
    });

    test('multi-root: bails early when feature is disabled in every open folder', async () => {
        const folderA = Uri.file(path.resolve('/wsA'));
        const folderB = Uri.file(path.resolve('/wsB'));
        getWorkspaceFoldersStub.returns([
            { uri: folderA, name: 'wsA', index: 0 },
            { uri: folderB, name: 'wsB', index: 1 },
        ]);
        // Disabled in every folder AND at the no-scope level.
        isEnabledStub.returns(false);

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();
        await waitForImmediate();
        assert.strictEqual(result, undefined);
        assert.ok(findFilesStub.notCalled, 'should not scan when no folder has the feature enabled');
        assert.ok(showErrorStub.calledOnce);
    });

    test('multi-root: scans when feature is enabled in at least one folder, filters candidates by per-folder setting', async () => {
        const folderA = Uri.file(path.resolve('/wsA'));
        const folderB = Uri.file(path.resolve('/wsB'));
        const scriptA = Uri.file(path.resolve('/wsA/a.py'));
        const scriptB = Uri.file(path.resolve('/wsB/b.py'));
        getWorkspaceFoldersStub.returns([
            { uri: folderA, name: 'wsA', index: 0 },
            { uri: folderB, name: 'wsB', index: 1 },
        ]);

        // Per-folder setting: enabled for wsA, disabled for wsB and
        // the no-scope read (window-level).
        isEnabledStub.callsFake((scope?: Uri) => {
            if (!scope) {
                return false;
            }
            return scope.fsPath.startsWith(folderA.fsPath);
        });

        // findFiles returns one candidate from each folder.
        findFilesStub.resolves([scriptA, scriptB]);
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === scriptA.toString())).resolves(META_A);
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === scriptB.toString())).resolves(META_B);

        // Capture what the picker is shown.
        let pickerItems: Array<{ uri: Uri }> = [];
        showQuickPickStub.callsFake(async (items: Array<{ label: string; uri: Uri }>) => {
            pickerItems = items;
            return items;
        });

        const detector = new InlineScriptDetector(pm.object);
        const result = await detector.create();

        assert.ok(result && result.length === 1, 'only the enabled-folder script should be offered');
        assert.strictEqual(result![0].uri.toString(), scriptA.toString());
        assert.strictEqual(pickerItems.length, 1, 'picker should only contain the enabled-folder script');
        assert.strictEqual(pickerItems[0].uri.toString(), scriptA.toString());
        // The disabled-folder candidate must not have been read.
        assert.ok(
            readMetadataStub.neverCalledWith(sinon.match((u: Uri) => u.toString() === scriptB.toString())),
            'should not read metadata for files in disabled folders',
        );
    });
});

suite('scanForInlineScripts', () => {
    let readMetadataStub: sinon.SinonStub;

    setup(() => {
        readMetadataStub = sinon.stub(ism, 'readInlineScriptMetadataFromFile');
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns only URIs whose metadata is defined', async () => {
        const uriA = Uri.file(path.resolve('/ws/a.py'));
        const uriB = Uri.file(path.resolve('/ws/b.py'));
        const uriC = Uri.file(path.resolve('/ws/c.py'));
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriA.toString())).resolves(META_A);
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriB.toString())).resolves(undefined);
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriC.toString())).resolves(META_B);

        const results = await scanForInlineScripts([uriA, uriB, uriC]);
        const got = new Map(results.map((r) => [r.uri.toString(), r.metadata]));
        assert.strictEqual(got.size, 2);
        assert.strictEqual(got.get(uriA.toString()), META_A);
        assert.strictEqual(got.get(uriC.toString()), META_B);
    });

    test('swallows per-file read errors and continues', async () => {
        const uriA = Uri.file(path.resolve('/ws/a.py'));
        const uriB = Uri.file(path.resolve('/ws/b.py'));
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriA.toString())).rejects(new Error('boom'));
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === uriB.toString())).resolves(META_A);

        const results = await scanForInlineScripts([uriA, uriB]);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].uri.toString(), uriB.toString());
    });

    test('handles an empty input list', async () => {
        const results = await scanForInlineScripts([]);
        assert.deepStrictEqual(results, []);
        assert.ok(readMetadataStub.notCalled);
    });
});
