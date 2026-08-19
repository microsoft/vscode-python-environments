// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, TextDocument, TextDocumentChangeEvent, TextDocumentContentChangeEvent, Uri } from 'vscode';
import * as ism from '../../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import * as wapi from '../../../common/workspace.apis';
import { InlineScriptLazyDetector, shouldHandleUri } from '../../../features/inlineScript/lazyDetector';

let docDirtyByUri = new Map<string, boolean>();

function makeDoc(uri: Uri): TextDocument {
    return {
        uri,
        getText: () => '',
        isDirty: docDirtyByUri.get(uri.toString()) ?? false,
    } as TextDocument;
}

const NON_EMPTY_CHANGES: readonly TextDocumentContentChangeEvent[] = [
    { range: undefined as never, rangeOffset: 0, rangeLength: 0, text: 'x' },
];

function makeChange(
    uri: Uri,
    changes: readonly TextDocumentContentChangeEvent[] = NON_EMPTY_CHANGES,
): TextDocumentChangeEvent {
    return {
        document: makeDoc(uri),
        contentChanges: changes,
        reason: undefined,
    } as TextDocumentChangeEvent;
}

const VALID_METADATA: ism.InlineScriptMetadata = {
    requiresPython: '>=3.11',
    dependencies: ['requests', 'rich'],
    tool: undefined,
    range: { start: 0, end: 40 },
};

suite('InlineScriptLazyDetector', () => {
    let onDidOpenStub: sinon.SinonStub;
    let onDidSaveStub: sinon.SinonStub;
    let onDidChangeStub: sinon.SinonStub;
    let onDidDeleteStub: sinon.SinonStub;
    let onDidRenameStub: sinon.SinonStub;
    let getOpenTextDocumentsStub: sinon.SinonStub;
    let getWorkspaceFolderStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;
    let routingRegistry: InlineScriptRoutingRegistry;
    let openListener: ((doc: TextDocument) => unknown) | undefined;
    let saveListener: ((doc: TextDocument) => unknown) | undefined;
    let changeListener: ((e: TextDocumentChangeEvent) => unknown) | undefined;
    let deleteListener: ((e: { files: readonly Uri[] }) => unknown) | undefined;
    let renameListener: ((e: { files: readonly { oldUri: Uri; newUri: Uri }[] }) => unknown) | undefined;

    setup(() => {
        openListener = undefined;
        saveListener = undefined;
        changeListener = undefined;
        deleteListener = undefined;
        renameListener = undefined;
        docDirtyByUri = new Map();
        routingRegistry = new InlineScriptRoutingRegistry();

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

        onDidChangeStub = sinon.stub(wapi, 'onDidChangeTextDocument');
        onDidChangeStub.callsFake((listener: (e: TextDocumentChangeEvent) => unknown) => {
            changeListener = listener;
            return new Disposable(() => {
                changeListener = undefined;
            });
        });

        onDidDeleteStub = sinon.stub(wapi, 'onDidDeleteFiles');
        onDidDeleteStub.callsFake((listener: (e: { files: readonly Uri[] }) => unknown) => {
            deleteListener = listener;
            return new Disposable(() => {
                deleteListener = undefined;
            });
        });

        onDidRenameStub = sinon.stub(wapi, 'onDidRenameFiles');
        onDidRenameStub.callsFake((listener: (e: { files: readonly { oldUri: Uri; newUri: Uri }[] }) => unknown) => {
            renameListener = listener;
            return new Disposable(() => {
                renameListener = undefined;
            });
        });

        getOpenTextDocumentsStub = sinon.stub(wapi, 'getOpenTextDocuments');
        getOpenTextDocumentsStub.returns([]);

        getWorkspaceFolderStub = sinon.stub(wapi, 'getWorkspaceFolder');
        getWorkspaceFolderStub.callsFake((uri: Uri) => ({
            uri: Uri.file(path.dirname(uri.fsPath)),
            name: 'mockWorkspace',
            index: 0,
        }));

        readMetadataStub = sinon.stub(ism, 'readInlineScriptMetadataFromFile');
        readMetadataStub.resolves(undefined);

        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sinon.restore();
    });

    function createDetector(): InlineScriptLazyDetector {
        const detector = new InlineScriptLazyDetector(routingRegistry);
        detector.activate();
        return detector;
    }

    function createDetectorWithoutRouting(): InlineScriptLazyDetector {
        const detector = new InlineScriptLazyDetector();
        detector.activate();
        return detector;
    }

    async function fireOpen(uri: Uri): Promise<void> {
        assert.ok(openListener, 'open listener should be registered after activate()');
        await openListener!(makeDoc(uri));
    }

    async function fireSave(uri: Uri): Promise<void> {
        assert.ok(saveListener, 'save listener should be registered after activate()');
        await saveListener!(makeDoc(uri));
    }

    function fireChange(uri: Uri, changes: readonly TextDocumentContentChangeEvent[] = NON_EMPTY_CHANGES): void {
        assert.ok(changeListener, 'change listener should be registered after activate()');
        changeListener!(makeChange(uri, changes));
    }

    function makeContentChanges(rangeOffset: number): readonly TextDocumentContentChangeEvent[] {
        return [{ range: undefined as never, rangeOffset, rangeLength: 0, text: 'x' }];
    }

    function setDocDirty(uri: Uri, isDirty: boolean): void {
        docDirtyByUri.set(uri.toString(), isDirty);
    }

    function fireDelete(...uris: Uri[]): void {
        assert.ok(deleteListener, 'delete listener should be registered after activate()');
        deleteListener!({ files: uris });
    }

    function fireRename(oldUri: Uri, newUri: Uri): void {
        assert.ok(renameListener, 'rename listener should be registered after activate()');
        renameListener!({ files: [{ oldUri, newUri }] });
    }

    function callsFor(name: EventNames): sinon.SinonSpyCall[] {
        return sendTelemetryStub.getCalls().filter((c) => c.args[0] === name);
    }

    function flushImmediate(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    test('activate() subscribes to document and file events', () => {
        const detector = createDetector();
        assert.ok(onDidOpenStub.calledOnce, 'should subscribe to onDidOpenTextDocument');
        assert.ok(onDidSaveStub.calledOnce, 'should subscribe to onDidSaveTextDocument');
        assert.ok(onDidChangeStub.calledOnce, 'should subscribe to onDidChangeTextDocument');
        assert.ok(onDidDeleteStub.calledOnce, 'should subscribe to onDidDeleteFiles');
        assert.ok(onDidRenameStub.calledOnce, 'should subscribe to onDidRenameFiles');
        detector.dispose();
    });

    test('activate() without routing subscribes only to document events', () => {
        const detector = createDetectorWithoutRouting();
        assert.ok(onDidOpenStub.calledOnce, 'should subscribe to onDidOpenTextDocument');
        assert.ok(onDidSaveStub.calledOnce, 'should subscribe to onDidSaveTextDocument');
        assert.ok(onDidChangeStub.calledOnce, 'should subscribe to onDidChangeTextDocument');
        assert.ok(onDidDeleteStub.notCalled, 'should not subscribe to onDidDeleteFiles');
        assert.ok(onDidRenameStub.notCalled, 'should not subscribe to onDidRenameFiles');
        detector.dispose();
    });

    test('skips non-file URI schemes', async () => {
        const detector = createDetector();
        await fireOpen(Uri.parse('untitled:foo.py'));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-file URI');
        detector.dispose();
    });

    test('skips non-.py files', async () => {
        const detector = createDetector();
        await fireOpen(Uri.file(path.resolve('/ws/foo.txt')));
        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-.py files');
        detector.dispose();
    });

    test('skips telemetry for files outside any workspace folder but still refreshes saved routing metadata', async () => {
        getWorkspaceFolderStub.returns(undefined);
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(Uri.file(path.resolve('/elsewhere/foo.py')), true);
        const detector = createDetector();
        const uri = Uri.file(path.resolve('/elsewhere/foo.py'));
        await fireOpen(uri);
        assert.ok(readMetadataStub.calledOnceWithExactly(uri), 'should still read saved metadata for routing');
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_DETECTED).length, 0, 'should not emit telemetry');
        detector.dispose();
    });

    test('without routing skips files outside any workspace folder', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/foo.py'));
        const setMetadataSpy = sinon.spy(InlineScriptRoutingRegistry.prototype, 'setMetadata');
        getWorkspaceFolderStub.returns(undefined);
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetectorWithoutRouting();

        await fireOpen(uri);

        assert.ok(readMetadataStub.notCalled, 'should not read files outside the workspace');
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_DETECTED).length, 0, 'should not emit telemetry');
        assert.ok(setMetadataSpy.notCalled, 'off-mode should not update routing metadata');
        detector.dispose();
    });

    test('reads metadata for an in-workspace .py file on open', async () => {
        const uri = Uri.file(path.resolve('/ws/foo.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);
        assert.strictEqual(readMetadataStub.callCount, 1, 'open should trigger exactly one read');
        assert.strictEqual((readMetadataStub.firstCall.args[0] as Uri).toString(), uri.toString());
        detector.dispose();
    });

    test('reads metadata for an in-workspace .py file on save', async () => {
        const uri = Uri.file(path.resolve('/ws/bar.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireSave(uri);
        assert.strictEqual(readMetadataStub.callCount, 1, 'save should trigger exactly one read');
        detector.dispose();
    });

    test('withholds routeability and skips disk reads for dirty documents on open', async () => {
        const uri = Uri.file(path.resolve('/ws/dirty.py'));
        setDocDirty(uri, true);
        routingRegistry.setMetadata(uri, VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri, true);
        const detector = createDetector();

        await fireOpen(uri);

        assert.ok(readMetadataStub.notCalled, 'dirty open should not read saved metadata');
        assert.strictEqual(routingRegistry.getMetadata(uri), undefined);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        detector.dispose();
    });

    test('without routing replays dirty workspace documents from saved disk and preserves edited duration gating', async () => {
        const uri = Uri.file(path.resolve('/ws/restoredDirty.py'));
        const setMetadataSpy = sinon.spy(InlineScriptRoutingRegistry.prototype, 'setMetadata');
        const clearMetadataSpy = sinon.spy(InlineScriptRoutingRegistry.prototype, 'clearMetadata');
        const validateAssociationSpy = sinon.spy(InlineScriptRoutingRegistry.prototype, 'setValidatedAssociation');
        sinon.stub(Date, 'now').onFirstCall().returns(1_000).onSecondCall().returns(1_250);
        setDocDirty(uri, true);
        getOpenTextDocumentsStub.returns([makeDoc(uri)]);
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetectorWithoutRouting();

        await flushImmediate();
        await flushImmediate();
        fireChange(uri);

        assert.ok(readMetadataStub.calledOnceWithExactly(uri), 'dirty replay should still read saved metadata');
        const detectedCalls = callsFor(EventNames.INLINE_SCRIPT_DETECTED);
        assert.strictEqual(detectedCalls.length, 1, 'dirty replay should still emit detection telemetry');
        assert.strictEqual(detectedCalls[0].args[2].trigger, 'open');
        const editedCalls = callsFor(EventNames.INLINE_SCRIPT_EDITED);
        assert.strictEqual(editedCalls.length, 1, 'first edit after dirty replay should still emit telemetry');
        assert.strictEqual(editedCalls[0].args[1], 250, 'edited duration should still be based on the detection time');
        assert.ok(setMetadataSpy.notCalled, 'off-mode should not write routing metadata');
        assert.ok(clearMetadataSpy.notCalled, 'off-mode should not clear routing metadata');
        assert.ok(validateAssociationSpy.notCalled, 'off-mode should not change routing associations');
        detector.dispose();
    });

    test('concurrent open + open coalesces to a single read', async () => {
        const uri = Uri.file(path.resolve('/ws/dedup.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await Promise.all([fireOpen(uri), fireOpen(uri)]);
        assert.strictEqual(readMetadataStub.callCount, 1, 'open+open should coalesce to a single read');
        detector.dispose();
    });

    test('an in-flight open followed by save reads fresh metadata and cannot publish stale routing data', async () => {
        const uri = Uri.file(path.resolve('/ws/race.py'));
        const staleRead = createDeferred<ism.InlineScriptMetadata>();
        const savedMetadata = {
            ...VALID_METADATA,
            dependencies: ['saved'],
        } satisfies ism.InlineScriptMetadata;
        const savedRead = createDeferred<ism.InlineScriptMetadata>();
        readMetadataStub.onFirstCall().returns(staleRead.promise);
        readMetadataStub.onSecondCall().returns(savedRead.promise);
        routingRegistry.setValidatedAssociation(uri, true);
        const detector = createDetector();
        const open = openListener!(makeDoc(uri)) as Promise<void>;
        const save = saveListener!(makeDoc(uri)) as Promise<void>;

        assert.strictEqual(readMetadataStub.callCount, 1, 'save must wait for the older open read');
        staleRead.resolve(VALID_METADATA);
        await open;
        await flushImmediate();

        assert.strictEqual(readMetadataStub.callCount, 2, 'save must trigger a fresh post-save read');
        assert.strictEqual(routingRegistry.getMetadata(uri), undefined, 'stale open data must not be published');
        savedRead.resolve(savedMetadata);
        await save;

        assert.deepStrictEqual(routingRegistry.getMetadata(uri), savedMetadata);
        assert.strictEqual(routingRegistry.shouldRoute(uri), true);
        detector.dispose();
    });

    test('telemetry-only concurrent open + save still coalesces to a single read', async () => {
        const uri = Uri.file(path.resolve('/ws/telemetry-race.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetectorWithoutRouting();
        await Promise.all([fireOpen(uri), fireSave(uri)]);
        assert.strictEqual(readMetadataStub.callCount, 1, 'telemetry-only mode should retain the original coalescing');
        detector.dispose();
    });

    test('dispose() during an in-flight read bails out before emitting telemetry', async () => {
        const uri = Uri.file(path.resolve('/ws/disposed.py'));
        let resolveRead: ((meta: ism.InlineScriptMetadata) => void) | undefined;
        readMetadataStub.returns(
            new Promise<ism.InlineScriptMetadata>((resolve) => {
                resolveRead = resolve;
            }),
        );

        const detector = createDetector();
        const inFlight = openListener!(makeDoc(uri)) as Promise<void> | undefined;
        detector.dispose();
        resolveRead!(VALID_METADATA);
        await assert.doesNotReject(inFlight ?? Promise.resolve());
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_DETECTED).length, 0, 'no detection event after dispose');
    });

    test('tracks loose local .py files for routing even when telemetry skips them', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/loose.py'));
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri.fsPath, true);
        getWorkspaceFolderStub.returns(undefined);
        const detector = createDetector();

        await fireOpen(uri);

        assert.strictEqual(routingRegistry.shouldRoute(uri), true);
        assert.ok(readMetadataStub.calledOnceWithExactly(uri), 'loose files should still refresh saved metadata');
        detector.dispose();
    });

    test('replays already-open loose .py documents for routing on activation', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/replayed.py'));
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri.fsPath, true);
        getWorkspaceFolderStub.returns(undefined);
        getOpenTextDocumentsStub.returns([makeDoc(uri)]);

        const detector = createDetector();
        await flushImmediate();

        assert.strictEqual(routingRegistry.shouldRoute(uri), true);
        assert.ok(readMetadataStub.calledOnceWithExactly(uri), 'loose replay should refresh saved metadata');
        detector.dispose();
    });

    test('clears routeability on header edits and refreshes saved metadata on the next save', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/edited.py'));
        routingRegistry.setValidatedAssociation(uri, true);
        readMetadataStub.onFirstCall().resolves(VALID_METADATA);
        readMetadataStub.onSecondCall().resolves(VALID_METADATA);
        const detector = createDetector();

        await fireOpen(uri);
        assert.strictEqual(routingRegistry.shouldRoute(uri), true);

        fireChange(uri, makeContentChanges(0));
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);

        await fireSave(uri);
        assert.deepStrictEqual(routingRegistry.getMetadata(uri), VALID_METADATA);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        detector.dispose();
    });

    test('preserves routing when edits are after the metadata block', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/bodyEdit.py'));
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri, true);
        const detector = createDetector();

        await fireOpen(uri);
        const metadata = routingRegistry.getMetadata(uri);
        assert.ok(metadata, 'expected routing metadata after open');

        fireChange(uri, makeContentChanges(metadata!.range.end + 5));

        assert.strictEqual(routingRegistry.shouldRoute(uri), true);
        detector.dispose();
    });

    test('invalidates routing for a CRLF dependency edit using source offsets', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/crlf.py'));
        const source = [
            '# /// script',
            ...Array.from({ length: 40 }, () => '#'),
            '# dependencies = ["requests"]',
            '# ///',
            'print("body")',
        ].join('\r\n');
        const metadata = ism.readInlineScriptMetadata(source);
        assert.ok(metadata?.sourceRange, 'parsed metadata should include source offsets');
        const dependencyOffset = source.indexOf('# dependencies');
        assert.ok(
            dependencyOffset >= metadata.range.end,
            'test requires a raw CRLF dependency offset beyond the normalized range',
        );
        assert.ok(dependencyOffset < metadata.sourceRange.end);
        readMetadataStub.resolves(metadata);
        routingRegistry.setValidatedAssociation(uri, true);
        const detector = createDetector();

        await fireOpen(uri);
        fireChange(uri, makeContentChanges(dependencyOffset));

        assert.strictEqual(routingRegistry.getMetadata(uri), undefined);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        detector.dispose();
    });

    test('save rehydrates routing from saved file metadata rather than the live buffer', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/savedState.py'));
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri, true);
        const detector = createDetector();

        await fireSave(uri);

        assert.strictEqual(routingRegistry.shouldRoute(uri), true);
        detector.dispose();
    });

    test('restored dirty open with removed metadata stays non-routeable until save', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/restoredDirtyRemoved.py'));
        setDocDirty(uri, true);
        routingRegistry.setMetadata(uri, VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri, true);
        readMetadataStub.resolves(undefined);
        const detector = createDetector();

        await fireOpen(uri);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        assert.ok(readMetadataStub.notCalled);

        setDocDirty(uri, false);
        await fireSave(uri);
        assert.strictEqual(routingRegistry.getMetadata(uri), undefined);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        detector.dispose();
    });

    test('restored dirty open with changed metadata stays non-routeable until save', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/restoredDirtyChanged.py'));
        const changedMetadata = {
            ...VALID_METADATA,
            dependencies: ['urllib3'],
        } satisfies ism.InlineScriptMetadata;
        setDocDirty(uri, true);
        routingRegistry.setMetadata(uri, VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri, true);
        readMetadataStub.resolves(changedMetadata);
        const detector = createDetector();

        await fireOpen(uri);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        assert.ok(readMetadataStub.notCalled);

        setDocDirty(uri, false);
        await fireSave(uri);
        assert.deepStrictEqual(routingRegistry.getMetadata(uri), changedMetadata);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        detector.dispose();
    });

    test('clears routing metadata and validation when a file is deleted', async () => {
        const uri = Uri.file(path.resolve('/elsewhere/deleted.py'));
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(uri, true);
        const detector = createDetector();
        await fireOpen(uri);

        fireDelete(uri);

        assert.strictEqual(routingRegistry.getMetadata(uri), undefined);
        assert.strictEqual(routingRegistry.shouldRoute(uri), false);
        detector.dispose();
    });

    test('clears routing metadata and validation for the old path when a file is renamed', async () => {
        const oldUri = Uri.file(path.resolve('/elsewhere/old.py'));
        const newUri = Uri.file(path.resolve('/elsewhere/new.py'));
        readMetadataStub.resolves(VALID_METADATA);
        routingRegistry.setValidatedAssociation(oldUri, true);
        const detector = createDetector();
        await fireOpen(oldUri);

        fireRename(oldUri, newUri);

        assert.strictEqual(routingRegistry.getMetadata(oldUri), undefined);
        assert.strictEqual(routingRegistry.shouldRoute(oldUri), false);
        detector.dispose();
    });

    test('activate() replays already-open .py documents via setImmediate', async () => {
        const uriWithMeta = Uri.file(path.resolve('/ws/withMeta.py'));
        const uriPlain = Uri.file(path.resolve('/ws/plain.py'));
        const uriNonPy = Uri.file(path.resolve('/ws/skip.txt'));
        readMetadataStub.callsFake(async (u: Uri) =>
            u.toString() === uriWithMeta.toString() ? VALID_METADATA : undefined,
        );
        getOpenTextDocumentsStub.returns([makeDoc(uriWithMeta), makeDoc(uriPlain), makeDoc(uriNonPy)]);

        const detector = createDetector();
        await flushImmediate();
        await flushImmediate();

        assert.strictEqual(readMetadataStub.callCount, 2, 'should read each candidate .py document exactly once');
        const readUris = readMetadataStub.getCalls().map((c) => (c.args[0] as Uri).toString());
        assert.ok(readUris.includes(uriWithMeta.toString()));
        assert.ok(readUris.includes(uriPlain.toString()));
        assert.ok(!readUris.includes(uriNonPy.toString()), 'should not read non-.py URI during replay');
        detector.dispose();
    });

    test('dispose() cancels the pending catch-up replay', async () => {
        getOpenTextDocumentsStub.returns([makeDoc(Uri.file(path.resolve('/ws/never.py')))]);
        const detector = createDetector();
        detector.dispose();
        await flushImmediate();
        assert.ok(readMetadataStub.notCalled, 'dispose() must clear the pending setImmediate handle');
    });

    test('inlineScript.detected fires once with trigger=open + dependencyCount + hasRequiresPython', async () => {
        const uri = Uri.file(path.resolve('/ws/detect.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);

        const detectedCalls = callsFor(EventNames.INLINE_SCRIPT_DETECTED);
        assert.strictEqual(detectedCalls.length, 1, 'detection event should fire exactly once');
        const [, measures, properties] = detectedCalls[0].args;
        assert.deepStrictEqual(measures, { dependencyCount: 2 });
        assert.deepStrictEqual(properties, { trigger: 'open', hasRequiresPython: true });
        detector.dispose();
    });

    test('inlineScript.detected fires with trigger=save when surfaced by a save event', async () => {
        const uri = Uri.file(path.resolve('/ws/detectOnSave.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireSave(uri);

        const detectedCalls = callsFor(EventNames.INLINE_SCRIPT_DETECTED);
        assert.strictEqual(detectedCalls.length, 1);
        assert.strictEqual(detectedCalls[0].args[2].trigger, 'save');
        detector.dispose();
    });

    test('inlineScript.detected does not fire when the file has no metadata block', async () => {
        const uri = Uri.file(path.resolve('/ws/plain.py'));
        readMetadataStub.resolves(undefined);
        const detector = createDetector();
        await fireOpen(uri);
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_DETECTED).length, 0);
        detector.dispose();
    });

    test('inlineScript.detected is deduplicated across repeated opens and saves of the same URI', async () => {
        const uri = Uri.file(path.resolve('/ws/repeat.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);
        await fireSave(uri);
        await fireSave(uri);
        await fireOpen(uri);
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_DETECTED).length, 1, 'detection event must dedup per session');
        detector.dispose();
    });

    test('inlineScript.detected reports hasRequiresPython=false when not declared', async () => {
        const uri = Uri.file(path.resolve('/ws/noPython.py'));
        readMetadataStub.resolves({
            requiresPython: undefined,
            dependencies: [],
            tool: undefined,
            range: { start: 0, end: 20 },
        } satisfies ism.InlineScriptMetadata);
        const detector = createDetector();
        await fireOpen(uri);

        const [, measures, properties] = callsFor(EventNames.INLINE_SCRIPT_DETECTED)[0].args;
        assert.deepStrictEqual(measures, { dependencyCount: 0 });
        assert.deepStrictEqual(properties, { trigger: 'open', hasRequiresPython: false });
        detector.dispose();
    });

    test('inlineScript.edited fires once on first content change after detection', async () => {
        const uri = Uri.file(path.resolve('/ws/edit.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);
        fireChange(uri);

        const editedCalls = callsFor(EventNames.INLINE_SCRIPT_EDITED);
        assert.strictEqual(editedCalls.length, 1, 'edited event should fire exactly once');
        const measureArg = editedCalls[0].args[1];
        assert.strictEqual(typeof measureArg, 'number', 'measure should be a number (latency ms)');
        assert.ok((measureArg as number) >= 0, 'duration should be non-negative');
        detector.dispose();
    });

    test('inlineScript.edited is deduplicated across repeated edits of the same URI', async () => {
        const uri = Uri.file(path.resolve('/ws/multiEdit.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);
        fireChange(uri);
        fireChange(uri);
        fireChange(uri);
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_EDITED).length, 1);
        detector.dispose();
    });

    test('inlineScript.edited does not fire for changes on a URI that was never detected', async () => {
        const uri = Uri.file(path.resolve('/ws/notDetected.py'));
        readMetadataStub.resolves(undefined);
        const detector = createDetector();
        await fireOpen(uri);
        fireChange(uri);
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_EDITED).length, 0);
        detector.dispose();
    });

    test('inlineScript.edited ignores change events with no content changes', async () => {
        const uri = Uri.file(path.resolve('/ws/noOpChange.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);
        fireChange(uri, []);
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_EDITED).length, 0);
        fireChange(uri);
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_EDITED).length, 1);
        detector.dispose();
    });

    test('inlineScript.edited is suppressed after dispose()', async () => {
        const uri = Uri.file(path.resolve('/ws/disposedEdit.py'));
        readMetadataStub.resolves(VALID_METADATA);
        const detector = createDetector();
        await fireOpen(uri);
        const grabbedChangeListener = changeListener!;
        detector.dispose();
        grabbedChangeListener(makeChange(uri));
        assert.strictEqual(callsFor(EventNames.INLINE_SCRIPT_EDITED).length, 0);
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
