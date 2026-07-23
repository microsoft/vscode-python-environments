// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import * as pythonApi from '../../../features/pythonApi';
import * as helpers from '../../../helpers';
import { registerInlineScriptFeatures } from '../../../managers/builtin/inlineScriptMain';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

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

suite('registerInlineScriptFeatures (feature-flag gate)', () => {
    let isEnabledStub: sinon.SinonStub;
    let getPythonApiStub: sinon.SinonStub;
    let registerEnvironmentManagerStub: sinon.SinonStub;
    const nativeFinder = {} as NativePythonFinder;
    const baseManager = {} as EnvironmentManager;
    const globalStorageUri = Uri.file('inline-script-global-storage');

    setup(() => {
        isEnabledStub = sinon.stub(helpers, 'isInlineScriptsFeatureEnabled');
        registerEnvironmentManagerStub = sinon.stub<[unknown], Disposable>().returns({ dispose: () => undefined });
        getPythonApiStub = sinon.stub(pythonApi, 'getPythonApi').resolves({
            registerEnvironmentManager: registerEnvironmentManagerStub,
        } as unknown as PythonEnvironmentApi);
    });

    teardown(() => {
        sinon.restore();
    });

    test('when the feature flag is FALSE: does not register, does not even fetch the API', async () => {
        isEnabledStub.returns(false);
        const disposables: Disposable[] = [];

        await registerInlineScriptFeatures(nativeFinder, disposables, makeFakeLog(), baseManager, globalStorageUri);

        assert.strictEqual(disposables.length, 0, 'no disposables should be added when flag is off');
        assert.strictEqual(getPythonApiStub.called, false, 'should not even call getPythonApi when gated off');
        assert.strictEqual(registerEnvironmentManagerStub.called, false);
    });

    test('when the feature flag is TRUE: registers the manager and pushes the disposable', async () => {
        isEnabledStub.returns(true);
        const disposables: Disposable[] = [];

        await registerInlineScriptFeatures(nativeFinder, disposables, makeFakeLog(), baseManager, globalStorageUri);

        assert.strictEqual(getPythonApiStub.callCount, 1);
        assert.strictEqual(registerEnvironmentManagerStub.callCount, 1);
        assert.strictEqual(disposables.length, 2, 'expected manager + registration disposable');
        const manager = registerEnvironmentManagerStub.firstCall.args[0];
        assert.strictEqual(typeof manager.create, 'function');
    });
});
