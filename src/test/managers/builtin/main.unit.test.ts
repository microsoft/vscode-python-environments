// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, EventEmitter, LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
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
        const deletionWatcher = createMockWatcher();
        createFileSystemWatcherStub.withArgs('{**/activate}').returns(mockWatcher);
        createFileSystemWatcherStub.withArgs('**/*').returns(deletionWatcher);

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
        assert.strictEqual(createFileSystemWatcherStub.callCount, 2);
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

    test('deleting a folder that holds a known venv triggers refresh', async () => {
        const deletionWatcher = createMockWatcher();
        createFileSystemWatcherStub.withArgs('{**/activate}').returns(createMockWatcher());
        createFileSystemWatcherStub.withArgs('**/*').returns(deletionWatcher);
        const venvFolder = Uri.file(path.resolve('workspace', '.venv'));
        sandbox
            .stub(VenvManager.prototype, 'hasEnvironmentAt')
            .callsFake((fsPath: string) => fsPath === venvFolder.fsPath);

        const disposables: Disposable[] = [];
        await registerSystemPythonFeatures(
            {} as NativePythonFinder,
            disposables,
            {} as LogOutputChannel,
            {} as SysPythonManager,
        );

        // Only deletions are watched: the folder is reported, not the files in it.
        assert.ok(createFileSystemWatcherStub.calledWithExactly('**/*', true, true, false));

        deletionWatcher._deleteEmitter.fire(Uri.file(path.resolve('workspace', 'notes.txt')));
        await clock.tickAsync(600);
        assert.strictEqual(watcherRefreshStub.callCount, 0);

        deletionWatcher._deleteEmitter.fire(venvFolder);
        await clock.tickAsync(600);
        assert.strictEqual(watcherRefreshStub.callCount, 1);

        disposables.forEach((d) => d.dispose());
    });
});

suite('VenvManager.hasEnvironmentAt', () => {
    const project = path.resolve('venv-delete-project');
    const venvPrefix = path.join(project, '.venv');

    function createManager(): VenvManager {
        const manager = new VenvManager(
            {} as NativePythonFinder,
            {} as PythonEnvironmentApi,
            {} as SysPythonManager,
            {} as LogOutputChannel,
        );
        (manager as unknown as { collection: PythonEnvironment[] }).collection = [
            { sysPrefix: venvPrefix } as PythonEnvironment,
        ];
        return manager;
    }

    test('is true for the venv folder and its parent folders', () => {
        const manager = createManager();

        assert.strictEqual(manager.hasEnvironmentAt(venvPrefix), true);
        assert.strictEqual(manager.hasEnvironmentAt(project), true);
    });

    test('is false for unrelated paths and paths inside the venv', () => {
        const manager = createManager();

        assert.strictEqual(manager.hasEnvironmentAt(path.join(project, 'src')), false);
        assert.strictEqual(manager.hasEnvironmentAt(path.join(venvPrefix, 'Lib', 'site-packages', 'pkg')), false);
        assert.strictEqual(manager.hasEnvironmentAt(path.resolve('venv-delete-project-other')), false);
        assert.strictEqual(manager.hasEnvironmentAt(`${venvPrefix}2`), false);
    });

    test('follows changes to the known environments', () => {
        const manager = createManager();
        const otherPrefix = path.resolve('venv-delete-other', '.venv');
        assert.strictEqual(manager.hasEnvironmentAt(otherPrefix), false);

        const state = manager as unknown as { collection: PythonEnvironment[] };
        state.collection.push({ sysPrefix: otherPrefix } as PythonEnvironment);
        assert.strictEqual(manager.hasEnvironmentAt(otherPrefix), true);

        state.collection = [];
        assert.strictEqual(manager.hasEnvironmentAt(venvPrefix), false);
        assert.strictEqual(manager.hasEnvironmentAt(otherPrefix), false);
    });
});
