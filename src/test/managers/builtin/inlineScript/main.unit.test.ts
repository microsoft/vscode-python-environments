// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../../api';
import * as cacheLayout from '../../../../common/inlineScript/cacheLayout';
import { InlineScriptRoutingRegistry } from '../../../../common/inlineScript/routingRegistry';
import * as persistentState from '../../../../common/persistentState';
import * as workspaceApis from '../../../../common/workspace.apis';
import { latchInlineScriptFeatureActivation } from '../../../../features/inlineScript/activation';
import { InlineScriptLazyDetector } from '../../../../features/inlineScript/lazyDetector';
import * as pythonApi from '../../../../features/pythonApi';
import * as helpers from '../../../../helpers';
import { InlineScriptEnvManager } from '../../../../managers/builtin/inlineScript/envManager';
import { registerInlineScriptFeatures } from '../../../../managers/builtin/inlineScript/main';
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

suite('registerInlineScriptFeatures (feature-flag gate)', () => {
    let isEnabledStub: sinon.SinonStub;
    let getPythonApiStub: sinon.SinonStub;
    let registerEnvironmentManagerStub: sinon.SinonStub;
    let startActivationDiscoveryStub: sinon.SinonStub;
    let onDidDeleteFilesStub: sinon.SinonStub;
    let onDidRenameFilesStub: sinon.SinonStub;
    const nativeFinder = {} as NativePythonFinder;
    const baseManager = {} as EnvironmentManager;
    const globalStorageUri = Uri.file('inline-script-global-storage');
    const routingRegistry = new InlineScriptRoutingRegistry();

    setup(() => {
        isEnabledStub = sinon.stub(helpers, 'isInlineScriptsFeatureEnabled');
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
        } as unknown as PythonEnvironmentApi);
    });

    teardown(() => {
        sinon.restore();
    });

    test('when the feature flag is FALSE: does not register, does not even fetch the API', async () => {
        const disposables: Disposable[] = [];

        await registerInlineScriptFeatures(
            nativeFinder,
            disposables,
            makeFakeLog(),
            baseManager,
            globalStorageUri,
            { enabled: false, routingRegistry: undefined },
        );

        assert.strictEqual(disposables.length, 0, 'no disposables should be added when flag is off');
        assert.strictEqual(getPythonApiStub.called, false, 'should not even call getPythonApi when gated off');
        assert.strictEqual(registerEnvironmentManagerStub.called, false);
    });

    test('when the feature flag is TRUE without a routing registry: fails before touching the API', async () => {
        const disposables: Disposable[] = [];

        await assert.rejects(
            registerInlineScriptFeatures(
                nativeFinder,
                disposables,
                makeFakeLog(),
                baseManager,
                globalStorageUri,
                { enabled: true, routingRegistry: undefined },
            ),
            /routing registry/i,
        );

        assert.strictEqual(disposables.length, 0, 'no disposables should be added when the registry is missing');
        assert.strictEqual(getPythonApiStub.called, false, 'should fail before getPythonApi when the registry is missing');
        assert.strictEqual(registerEnvironmentManagerStub.called, false);
    });

    test('when the feature flag is TRUE: registers the manager and pushes the disposable', async () => {
        const disposables: Disposable[] = [];

        await registerInlineScriptFeatures(
            nativeFinder,
            disposables,
            makeFakeLog(),
            baseManager,
            globalStorageUri,
            { enabled: true, routingRegistry },
        );

        assert.strictEqual(getPythonApiStub.callCount, 1);
        assert.strictEqual(registerEnvironmentManagerStub.callCount, 1);
        assert.strictEqual(disposables.length, 2, 'expected manager + registration disposable');
        const manager = registerEnvironmentManagerStub.firstCall.args[0];
        assert.ok(disposables.includes(manager), 'manager itself should be disposed');
        assert.ok(
            disposables.includes(registerEnvironmentManagerStub.firstCall.returnValue),
            'registration disposable should be disposed',
        );
        assert.strictEqual(
            (manager as unknown as { routingRegistry: InlineScriptRoutingRegistry }).routingRegistry,
            routingRegistry,
            'the registered manager must share the activation routing registry',
        );
        assert.strictEqual(typeof manager.create, 'function');
        await nextTurn();
        disposables.forEach((disposable) => disposable.dispose());
    });

    test('when the feature flag is TRUE: defers activation-time discovery to the next turn', async () => {
        const disposables: Disposable[] = [];

        await registerInlineScriptFeatures(
            nativeFinder,
            disposables,
            makeFakeLog(),
            baseManager,
            globalStorageUri,
            { enabled: true, routingRegistry },
        );

        assert.strictEqual(
            startActivationDiscoveryStub.callCount,
            0,
            'activation should not synchronously start bootstrap discovery',
        );

        await nextTurn();

        sinon.assert.calledOnceWithExactly(startActivationDiscoveryStub);
        disposables.forEach((disposable) => disposable.dispose());
    });

    test('latches FALSE through deferred registration even if the live setting flips TRUE later', async () => {
        isEnabledStub.onFirstCall().returns(false);
        isEnabledStub.onSecondCall().returns(true);
        const activation = latchInlineScriptFeatureActivation();
        const disposables: Disposable[] = [];

        await (activation.enabled
            ? registerInlineScriptFeatures(
                  nativeFinder,
                  disposables,
                  makeFakeLog(),
                  baseManager,
                  globalStorageUri,
                  activation,
              )
            : Promise.resolve());

        assert.strictEqual(activation.enabled, false);
        assert.strictEqual(activation.routingRegistry, undefined);
        assert.strictEqual(isEnabledStub.callCount, 1, 'activation should read the setting only once');
        assert.strictEqual(disposables.length, 0, 'disabled activation should not add disposables later');
        assert.strictEqual(getPythonApiStub.called, false, 'disabled activation should never touch the API later');
        assert.strictEqual(registerEnvironmentManagerStub.called, false);
    });

    test('absent flag performs no inline registration, persistence, cache, or routing-listener work', async () => {
        isEnabledStub.returns(false);
        const persistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        const inspectMetaJsonStub = sinon.stub(cacheLayout, 'inspectMetaJson');
        const writeMetaJsonStub = sinon.stub(cacheLayout, 'writeMetaJson');
        sinon.stub(workspaceApis, 'onDidOpenTextDocument').returns(new Disposable(() => undefined));
        sinon.stub(workspaceApis, 'onDidSaveTextDocument').returns(new Disposable(() => undefined));
        sinon.stub(workspaceApis, 'onDidChangeTextDocument').returns(new Disposable(() => undefined));
        sinon.stub(workspaceApis, 'getOpenTextDocuments').returns([]);

        const activation = latchInlineScriptFeatureActivation();
        const detector = new InlineScriptLazyDetector(activation.routingRegistry);
        detector.activate();
        const disposables: Disposable[] = [];
        await (activation.enabled
            ? registerInlineScriptFeatures(
                  nativeFinder,
                  disposables,
                  makeFakeLog(),
                  baseManager,
                  globalStorageUri,
                  activation,
              )
            : Promise.resolve());
        await nextTurn();

        assert.strictEqual(activation.enabled, false);
        assert.strictEqual(activation.routingRegistry, undefined);
        assert.strictEqual(isEnabledStub.callCount, 1);
        assert.strictEqual(getPythonApiStub.callCount, 0);
        assert.strictEqual(registerEnvironmentManagerStub.callCount, 0);
        assert.strictEqual(startActivationDiscoveryStub.callCount, 0);
        assert.strictEqual(persistentStateStub.callCount, 0);
        assert.strictEqual(inspectMetaJsonStub.callCount, 0);
        assert.strictEqual(writeMetaJsonStub.callCount, 0);
        assert.strictEqual(onDidDeleteFilesStub.callCount, 0);
        assert.strictEqual(onDidRenameFilesStub.callCount, 0);
        assert.strictEqual(disposables.length, 0);
        detector.dispose();
    });

    test('latches TRUE through deferred registration even if the live setting flips FALSE later', async () => {
        isEnabledStub.onFirstCall().returns(true);
        isEnabledStub.onSecondCall().returns(false);
        const activation = latchInlineScriptFeatureActivation();
        const disposables: Disposable[] = [];

        await (activation.enabled
            ? registerInlineScriptFeatures(
                  nativeFinder,
                  disposables,
                  makeFakeLog(),
                  baseManager,
                  globalStorageUri,
                  activation,
              )
            : Promise.resolve());

        assert.strictEqual(activation.enabled, true);
        assert.ok(activation.routingRegistry, 'enabled activation should latch a routing registry');
        assert.strictEqual(isEnabledStub.callCount, 1, 'deferred registration should not reread the setting');
        assert.strictEqual(getPythonApiStub.callCount, 1);
        assert.strictEqual(registerEnvironmentManagerStub.callCount, 1);
        assert.strictEqual(disposables.length, 2, 'enabled activation should still register later');
    });
});
