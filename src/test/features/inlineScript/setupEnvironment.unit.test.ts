// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import * as typemoq from 'typemoq';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../../../common/constants';
import { InlineScriptMetadata } from '../../../common/inlineScript/metadata';
import * as metadataApi from '../../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import {
    notifyInlineScriptSetupOutcome,
    setUpInlineScriptEnvironment,
    setUpInlineScriptEnvironmentsInWorkspace,
} from '../../../features/inlineScript/setupEnvironment';
import { EnvironmentManagers, InternalEnvironmentManager } from '../../../internal.api';

function makeEnv(): PythonEnvironment {
    return {
        envId: { id: 'env1', managerId: INLINE_SCRIPT_MANAGER_ID },
        name: 'inline',
        version: '3.12.0',
        environmentPath: Uri.file('/cache/env/python'),
        displayName: 'inline',
        displayPath: '/cache/env/python',
        execInfo: { run: { executable: '/cache/env/python' } },
        sysPrefix: '/cache/env',
    } as PythonEnvironment;
}

function makeMetadata(dependencies: string[]): InlineScriptMetadata {
    return {
        dependencies,
        range: { start: 0, end: 10 },
        sourceRange: { start: 0, end: 10 },
    };
}

suite('setUpInlineScriptEnvironment', () => {
    const scriptUri = Uri.file('/workspace/app.py');
    let em: typemoq.IMock<EnvironmentManagers>;
    let manager: typemoq.IMock<InternalEnvironmentManager>;
    let routing: InlineScriptRoutingRegistry;
    let readMetadataStub: sinon.SinonStub;
    let openDocumentsStub: sinon.SinonStub;

    setup(() => {
        em = typemoq.Mock.ofType<EnvironmentManagers>();
        manager = typemoq.Mock.ofType<InternalEnvironmentManager>();
        routing = new InlineScriptRoutingRegistry();
        readMetadataStub = sinon.stub(metadataApi, 'readInlineScriptMetadataFromFile').resolves(undefined);
        openDocumentsStub = sinon.stub(wapi, 'getOpenTextDocuments').returns([]);
        em.setup((m) => m.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID)).returns(() => manager.object);
    });

    teardown(() => {
        routing.dispose();
        sinon.restore();
    });

    test('returns undefined and sets no environment when the inline manager is not registered', async () => {
        em.reset();
        em.setup((m) => m.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID)).returns(() => undefined);

        const result = await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.strictEqual(result, undefined);
        em.verify((m) => m.setEnvironment(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
    });

    test('does not set an environment when creation produces none', async () => {
        manager.setup((m) => m.create(scriptUri, undefined)).returns(() => Promise.resolve(undefined));

        const result = await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.strictEqual(result, undefined);
        em.verify((m) => m.setEnvironment(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
    });

    test('creates then sets the environment for the script', async () => {
        const env = makeEnv();
        manager.setup((m) => m.create(scriptUri, undefined)).returns(() => Promise.resolve(env));
        em.setup((m) => m.setEnvironment(scriptUri, env)).returns(() => Promise.resolve());

        const result = await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.strictEqual(result, env);
        em.verify((m) => m.setEnvironment(scriptUri, env), typemoq.Times.once());
    });

    test('publishes saved metadata for a closed script so its project can route', async () => {
        // The lazy detector only observes open documents, so bulk setup of a closed script would
        // otherwise leave the registry with no metadata and the script permanently non-routeable.
        const metadata = makeMetadata(['requests']);
        readMetadataStub.resolves(metadata);
        const env = makeEnv();
        manager.setup((m) => m.create(scriptUri, undefined)).returns(() => Promise.resolve(env));
        em.setup((m) => m.setEnvironment(scriptUri, env)).returns(() => Promise.resolve());

        const result = await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.strictEqual(result, env);
        assert.deepStrictEqual(routing.getMetadata(scriptUri), metadata);
        sinon.assert.calledOnceWithExactly(readMetadataStub, scriptUri);
    });

    test('leaves an open document to the detector instead of publishing from disk', async () => {
        openDocumentsStub.returns([{ uri: scriptUri, isDirty: true }]);
        readMetadataStub.resolves(makeMetadata(['requests']));
        const env = makeEnv();
        manager.setup((m) => m.create(scriptUri, undefined)).returns(() => Promise.resolve(env));
        em.setup((m) => m.setEnvironment(scriptUri, env)).returns(() => Promise.resolve());

        await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.strictEqual(routing.getMetadata(scriptUri), undefined);
        sinon.assert.notCalled(readMetadataStub);
    });

    test('does not overwrite metadata the detector already published', async () => {
        const observed = makeMetadata(['observed']);
        routing.setMetadata(scriptUri, observed);
        readMetadataStub.resolves(makeMetadata(['from-disk']));
        const env = makeEnv();
        manager.setup((m) => m.create(scriptUri, undefined)).returns(() => Promise.resolve(env));
        em.setup((m) => m.setEnvironment(scriptUri, env)).returns(() => Promise.resolve());

        await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.deepStrictEqual(routing.getMetadata(scriptUri), observed);
        sinon.assert.notCalled(readMetadataStub);
    });

    test('skips association when the script metadata changes during creation', async () => {
        routing.setMetadata(scriptUri, makeMetadata(['a']));
        const env = makeEnv();
        manager
            .setup((m) => m.create(scriptUri, undefined))
            .returns(async () => {
                // Simulate the user editing + saving new dependencies while the environment is building.
                routing.setMetadata(scriptUri, makeMetadata(['b']));
                return env;
            });

        const result = await setUpInlineScriptEnvironment(scriptUri, em.object, routing);

        assert.strictEqual(result, undefined);
        em.verify((m) => m.setEnvironment(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
    });
});

suite('setUpInlineScriptEnvironmentsInWorkspace', () => {
    const withMeta = Uri.file('/workspace/with_meta.py');
    const withoutMeta = Uri.file('/workspace/plain.py');
    let em: typemoq.IMock<EnvironmentManagers>;
    let manager: typemoq.IMock<InternalEnvironmentManager>;
    let routing: InlineScriptRoutingRegistry;
    let findFilesStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let quickPickStub: sinon.SinonStub;
    let infoStub: sinon.SinonStub;

    setup(() => {
        em = typemoq.Mock.ofType<EnvironmentManagers>();
        manager = typemoq.Mock.ofType<InternalEnvironmentManager>();
        routing = new InlineScriptRoutingRegistry();
        em.setup((m) => m.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID)).returns(() => manager.object);

        findFilesStub = sinon.stub(wapi, 'findFiles');
        sinon.stub(wapi, 'asRelativePath').callsFake((p) => (p instanceof Uri ? p.fsPath : String(p)));
        sinon.stub(wapi, 'getOpenTextDocuments').returns([]);
        readMetadataStub = sinon.stub(metadataApi, 'readInlineScriptMetadataFromFile');
        quickPickStub = sinon.stub(winapi, 'showQuickPickWithButtons');
        infoStub = sinon.stub(winapi, 'showInformationMessage');
    });

    teardown(() => {
        routing.dispose();
        sinon.restore();
    });

    test('reports and sets up nothing when no files declare inline metadata', async () => {
        findFilesStub.resolves([withoutMeta]);
        readMetadataStub.resolves(undefined);

        await setUpInlineScriptEnvironmentsInWorkspace(em.object, routing);

        assert.ok(infoStub.calledOnce);
        manager.verify((m) => m.create(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
    });

    test('only sets up the selected files that declare inline metadata', async () => {
        findFilesStub.resolves([withMeta, withoutMeta]);
        readMetadataStub.callsFake(async (uri: Uri) =>
            uri.fsPath === withMeta.fsPath ? makeMetadata(['requests']) : undefined,
        );
        // Simulate the user accepting the pre-selected candidates.
        quickPickStub.callsFake((items) => items);
        const env = makeEnv();
        manager.setup((m) => m.create(withMeta, undefined)).returns(() => Promise.resolve(env));
        em.setup((m) => m.setEnvironment(withMeta, env)).returns(() => Promise.resolve());

        await setUpInlineScriptEnvironmentsInWorkspace(em.object, routing);

        manager.verify((m) => m.create(withMeta, undefined), typemoq.Times.once());
        manager.verify((m) => m.create(withoutMeta, undefined), typemoq.Times.never());
        em.verify((m) => m.setEnvironment(withMeta, env), typemoq.Times.once());
    });

    test('stops the whole run and reports when a script setup is cancelled', async () => {
        const warningStub = sinon.stub(winapi, 'showWarningMessage').resolves(undefined);
        // The picker sorts by label, so `a_` runs before `z_`.
        const first = Uri.file('/workspace/a_first.py');
        const second = Uri.file('/workspace/z_second.py');
        findFilesStub.resolves([first, second]);
        readMetadataStub.resolves(makeMetadata(['requests']));
        quickPickStub.callsFake((items) => items);
        manager
            .setup((m) => m.create(first, undefined))
            .returns(async () => {
                routing.noteSetupOutcome(first, { kind: 'cancelled' });
                return undefined;
            });

        await setUpInlineScriptEnvironmentsInWorkspace(em.object, routing);

        manager.verify((m) => m.create(first, undefined), typemoq.Times.once());
        manager.verify((m) => m.create(second, undefined), typemoq.Times.never());
        assert.match(warningStub.firstCall.args[0], /canceled/i);
        sinon.assert.notCalled(infoStub);
    });

    test('reports failures instead of silently counting them as successes', async () => {
        const warningStub = sinon.stub(winapi, 'showWarningMessage').resolves(undefined);
        findFilesStub.resolves([withMeta]);
        readMetadataStub.resolves(makeMetadata(['requests']));
        quickPickStub.callsFake((items) => items);
        manager
            .setup((m) => m.create(withMeta, undefined))
            .returns(async () => {
                routing.noteSetupOutcome(withMeta, { kind: 'failed', category: 'install-failure' });
                return undefined;
            });

        await setUpInlineScriptEnvironmentsInWorkspace(em.object, routing);

        assert.match(warningStub.firstCall.args[0], /failed/i);
        sinon.assert.notCalled(infoStub);
    });
});

suite('notifyInlineScriptSetupOutcome', () => {
    const scriptUri = Uri.file('/workspace/script.py');
    let routing: InlineScriptRoutingRegistry;

    setup(() => {
        routing = new InlineScriptRoutingRegistry();
    });

    teardown(() => {
        routing.dispose();
        sinon.restore();
    });

    test('reports cancellation as information, not a failure', () => {
        const infoStub = sinon.stub(winapi, 'showInformationMessage').resolves(undefined);
        const errorStub = sinon.stub(winapi, 'showErrorMessage').resolves(undefined);
        const warningStub = sinon.stub(winapi, 'showWarningMessage').resolves(undefined);
        routing.noteSetupOutcome(scriptUri, { kind: 'cancelled' });

        notifyInlineScriptSetupOutcome(scriptUri, routing);

        assert.match(infoStub.firstCall.args[0], /setup was canceled/i);
        sinon.assert.notCalled(errorStub);
        sinon.assert.notCalled(warningStub);
    });

    test('never asks the user to clean anything up after a cancellation', () => {
        const infoStub = sinon.stub(winapi, 'showInformationMessage').resolves(undefined);
        routing.noteSetupOutcome(scriptUri, { kind: 'cancelled' });

        notifyInlineScriptSetupOutcome(scriptUri, routing);

        assert.doesNotMatch(infoStub.firstCall.args[0], /clean up|quarantin|retry|lock/i);
    });

    test('lets coalesced setup callers observe the same outcome', () => {
        const infoStub = sinon.stub(winapi, 'showInformationMessage').resolves(undefined);
        const errorStub = sinon.stub(winapi, 'showErrorMessage').resolves(undefined);
        routing.noteSetupOutcome(scriptUri, { kind: 'cancelled' });

        notifyInlineScriptSetupOutcome(scriptUri, routing);
        notifyInlineScriptSetupOutcome(scriptUri, routing);

        sinon.assert.calledTwice(infoStub);
        sinon.assert.notCalled(errorStub);
    });
});
