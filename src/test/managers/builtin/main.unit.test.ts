// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, EventEmitter, LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import * as workspaceApis from '../../../common/workspace.apis';
import * as extensionApi from '../../../extensionApi';
import { registerSystemPythonFeatures } from '../../../managers/builtin/main';
import { SysPythonManager } from '../../../managers/builtin/sysPythonManager';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

suite('registerSystemPythonFeatures - activation watcher', () => {
    let sandbox: sinon.SinonSandbox;
    let createFileSystemWatcherStub: sinon.SinonStub;
    let watcherRefreshStub: sinon.SinonStub;
    let registerPackageManagerStub: sinon.SinonStub;
    let registerEnvironmentManagerStub: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;

    function createMockWatcher() {
        const onDidCreateEmitter = new EventEmitter<Uri>();
        const onDidDeleteEmitter = new EventEmitter<Uri>();
        const onDidChangeEmitter = new EventEmitter<Uri>();

        return {
            onDidCreate: onDidCreateEmitter.event,
            onDidDelete: onDidDeleteEmitter.event,
            onDidChange: onDidChangeEmitter.event,
            dispose: sandbox.stub(),
            _createEmitter: onDidCreateEmitter,
            _deleteEmitter: onDidDeleteEmitter,
            _changeEmitter: onDidChangeEmitter,
        };
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers();

        createFileSystemWatcherStub = sandbox.stub(workspaceApis, 'createFileSystemWatcher');
        sandbox.stub(workspaceApis, 'onDidDeleteFiles').returns(new Disposable(() => undefined));

        watcherRefreshStub = sandbox.stub(VenvManager.prototype, 'watcherRefresh').resolves();

        registerPackageManagerStub = sandbox.stub().returns(new Disposable(() => undefined));
        registerEnvironmentManagerStub = sandbox.stub().returns(new Disposable(() => undefined));

        sandbox.stub(extensionApi, 'getPythonApi').resolves({
            registerPackageManager: registerPackageManagerStub,
            registerEnvironmentManager: registerEnvironmentManagerStub,
        } as unknown as PythonEnvironmentApi);
    });

    teardown(() => {
        clock.restore();
        sandbox.restore();
    });

    test('activation watcher is created with change events enabled and triggers refresh on change', async () => {
        const mockWatcher = createMockWatcher();
        createFileSystemWatcherStub.returns(mockWatcher);

        const disposables: Disposable[] = [];
        const nativeFinder = {} as NativePythonFinder;
        const envManager = {} as SysPythonManager;
        const log = {
            info: sandbox.stub(),
            error: sandbox.stub(),
            warn: sandbox.stub(),
            debug: sandbox.stub(),
        } as unknown as LogOutputChannel;

        await registerSystemPythonFeatures(nativeFinder, disposables, log, envManager);

        // Assertion A: Watcher is created with [false, false, false]
        assert.strictEqual(createFileSystemWatcherStub.callCount, 1);
        assert.deepStrictEqual(createFileSystemWatcherStub.firstCall.args, ['{**/activate}', false, false, false]);

        // Assertion B & C: CHANGE event triggers debounced watcherRefresh
        const fakeUri = Uri.file('/test/workspace/.venv/bin/activate');
        mockWatcher._changeEmitter.fire(fakeUri);

        // Before debounce period expires, refresh should not have been called
        assert.strictEqual(watcherRefreshStub.callCount, 0);

        // Assertion D: Refresh is invoked exactly once after debounce period
        await clock.tickAsync(600);
        assert.strictEqual(watcherRefreshStub.callCount, 1);

        // Verify multiple rapid change events within debounce period are coalesced
        mockWatcher._changeEmitter.fire(fakeUri);
        mockWatcher._changeEmitter.fire(fakeUri);
        mockWatcher._changeEmitter.fire(fakeUri);
        await clock.tickAsync(600);
        assert.strictEqual(watcherRefreshStub.callCount, 2);

        // Assertion E: CREATE and DELETE handlers remain functional
        mockWatcher._createEmitter.fire(fakeUri);
        await clock.tickAsync(600);
        assert.strictEqual(watcherRefreshStub.callCount, 3);

        mockWatcher._deleteEmitter.fire(fakeUri);
        await clock.tickAsync(600);
        assert.strictEqual(watcherRefreshStub.callCount, 4);

        // Cleanup disposables and emitters
        mockWatcher._createEmitter.dispose();
        mockWatcher._changeEmitter.dispose();
        mockWatcher._deleteEmitter.dispose();
        disposables.forEach((d) => d.dispose());
    });
});
