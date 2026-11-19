// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, LogOutputChannel, Memento, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../../api';
import { InlineScriptRoutingRegistry } from '../../../../common/inlineScript/routingRegistry';
import * as workspaceApis from '../../../../common/workspace.apis';
import * as pythonApi from '../../../../extensionApi';
import { InlineScriptEnvManager } from '../../../../managers/builtin/inlineScript/envManager';
import {
    prepareInlineScriptFeatures,
    scheduleInlineScriptActivationDiscovery,
} from '../../../../managers/builtin/inlineScript/main';
import { NativePythonFinder } from '../../../../managers/common/nativePythonFinder';

function makeFakeLog(): LogOutputChannel {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        show: () => undefined,
        dispose: () => undefined,
        append: () => undefined,
        appendLine: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
        hide: () => undefined,
    } as unknown as LogOutputChannel;
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

suite('prepareInlineScriptFeatures', () => {
    let getPythonApiStub: sinon.SinonStub;
    let registerEnvironmentManagerStub: sinon.SinonStub;
    let startActivationDiscoveryStub: sinon.SinonStub;
    let onDidDeleteFilesStub: sinon.SinonStub;
    let onDidRenameFilesStub: sinon.SinonStub;
    const nativeFinder = {} as NativePythonFinder;
    const baseManager = {} as EnvironmentManager;
    const globalStorageUri = Uri.file('inline-script-global-storage');
    const routingRegistry = new InlineScriptRoutingRegistry();
    const workspaceMemento = {
        get: () => undefined,
        update: async () => undefined,
        keys: () => [],
    } as unknown as Memento;

    setup(() => {
        registerEnvironmentManagerStub = sinon.stub<[unknown], Disposable>().returns({ dispose: () => undefined });
        startActivationDiscoveryStub = sinon.stub(InlineScriptEnvManager.prototype, 'startActivationDiscovery');
        onDidDeleteFilesStub = sinon
            .stub(workspaceApis, 'onDidDeleteFiles')
            .returns(new Disposable(() => undefined));
        onDidRenameFilesStub = sinon
            .stub(workspaceApis, 'onDidRenameFiles')
            .returns(new Disposable(() => undefined));
        getPythonApiStub = sinon.stub(pythonApi, 'getPythonApi').resolves({
            registerEnvironmentManager: registerEnvironmentManagerStub,
            onDidChangePackages: () => new Disposable(() => undefined),
        } as unknown as PythonEnvironmentApi);
    });

    teardown(() => {
        sinon.restore();
    });

    test('prepares an inert manager and publishes it only at the commit point', async () => {
        const disposables: Disposable[] = [];
        const getPersistedState = sinon.spy(workspaceMemento, 'get');

        const prepared = await prepareInlineScriptFeatures(
            nativeFinder,
            disposables,
            makeFakeLog(),
            baseManager,
            globalStorageUri,
            routingRegistry,
            workspaceMemento,
        );

        assert.strictEqual(getPythonApiStub.callCount, 1);
        assert.strictEqual(registerEnvironmentManagerStub.callCount, 0);
        assert.strictEqual(onDidDeleteFilesStub.callCount, 0);
        assert.strictEqual(onDidRenameFilesStub.callCount, 0);
        assert.strictEqual(getPersistedState.callCount, 0);
        assert.strictEqual(disposables.length, 1);
        assert.strictEqual(disposables[0], prepared.manager);

        prepared.manager.start();
        await nextTurn();
        const registration = prepared.registerManager();
        disposables.push(registration);

        assert.strictEqual(registerEnvironmentManagerStub.callCount, 1);
        assert.strictEqual(registerEnvironmentManagerStub.firstCall.args[0], prepared.manager);
        assert.strictEqual(onDidDeleteFilesStub.callCount, 1);
        assert.strictEqual(onDidRenameFilesStub.callCount, 1);
        assert.ok(getPersistedState.calledOnce, 'persisted state should load only after start');
        assert.strictEqual(typeof prepared.manager.create, 'function');
        disposables.forEach((disposable) => disposable.dispose());
    });

    test('keeps the manager tracked for rollback when API publication fails', async () => {
        registerEnvironmentManagerStub.throws(new Error('registration failed'));
        const disposables: Disposable[] = [];
        const prepared = await prepareInlineScriptFeatures(
            nativeFinder,
            disposables,
            makeFakeLog(),
            baseManager,
            globalStorageUri,
            routingRegistry,
            workspaceMemento,
        );

        assert.throws(() => prepared.registerManager(), /registration failed/);
        assert.strictEqual(disposables.length, 1);
        assert.strictEqual(disposables[0], prepared.manager);
        disposables.forEach((disposable) => disposable.dispose());
    });

    test('schedules activation-time discovery only when requested by the caller', async () => {
        const disposables: Disposable[] = [];

        const prepared = await prepareInlineScriptFeatures(
            nativeFinder,
            disposables,
            makeFakeLog(),
            baseManager,
            globalStorageUri,
            routingRegistry,
            workspaceMemento,
        );

        assert.strictEqual(
            startActivationDiscoveryStub.callCount,
            0,
            'registration should not start discovery before the full feature transaction commits',
        );

        const scheduled = scheduleInlineScriptActivationDiscovery(prepared.manager);
        await nextTurn();

        sinon.assert.calledOnceWithExactly(startActivationDiscoveryStub);
        scheduled.dispose();
        disposables.forEach((disposable) => disposable.dispose());
    });
});
