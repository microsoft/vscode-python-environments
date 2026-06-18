// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, LogOutputChannel, RelativePattern, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    EnvironmentManager,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentId,
} from '../../../api';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    registerPackageWatcherForManager,
    watchPackageChangesForEnvironment,
} from '../../../managers/common/packageWatcher';

suite('Package Watcher', () => {
    let sandbox: sinon.SinonSandbox;
    let createFileSystemWatcherStub: sinon.SinonStub;
    let mockLogOutputChannel: Partial<LogOutputChannel>;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockLogOutputChannel = {
            error: sandbox.stub(),
            warn: sandbox.stub(),
            info: sandbox.stub(),
            debug: sandbox.stub(),
        };
        createFileSystemWatcherStub = sandbox.stub(workspaceApis, 'createFileSystemWatcher');
    });

    teardown(() => {
        sandbox.restore();
    });

    function createMockEnvironment(overrides?: Partial<PythonEnvironment>): PythonEnvironment {
        const envId: PythonEnvironmentId = {
            id: 'test-env-id',
            managerId: 'test-manager',
            ...overrides?.envId,
        };

        return {
            envId,
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            environmentPath: Uri.file('/path/to/env'),
            version: '3.11.0',
            sysPrefix: '/path/to/env',
            execInfo: {
                run: { executable: '/path/to/env/bin/python' },
            },
            ...overrides,
        } as unknown as PythonEnvironment;
    }

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

    function createMockPackageManager(): Partial<PackageManager> {
        return {
            refresh: sandbox.stub().resolves([]),
        };
    }

    function createMockEnvironmentManager(overrides?: Partial<EnvironmentManager>): Partial<EnvironmentManager> {
        const changeEmitter = new EventEmitter<DidChangeEnvironmentEventArgs>();

        return {
            onDidChangeEnvironment: changeEmitter.event,
            ...overrides,
        };
    }

    suite('watchPackageChangesForEnvironment', () => {
        test('should create file system watchers for watch targets', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Default should create watcher for site-packages metadata.
            assert.strictEqual(createFileSystemWatcherStub.callCount, 1, 'Should create 1 watcher (site-packages)');
        });

        test('should create correct watch patterns on Windows', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

            try {
                const env = createMockEnvironment({ sysPrefix: 'C:\\Users\\test\\env' });
                const packageManager = createMockPackageManager();

                watchPackageChangesForEnvironment(
                    env,
                    packageManager as PackageManager,
                    mockLogOutputChannel as LogOutputChannel,
                );

                const firstCall = createFileSystemWatcherStub.getCall(0);
                const pattern = firstCall.args[0] as RelativePattern;

                assert.ok(pattern.baseUri.fsPath.includes('Lib'), 'Should use Lib for Windows');
                assert.strictEqual(
                    pattern.pattern,
                    'site-packages/**/*.dist-info/METADATA',
                    'Should watch .dist-info METADATA files',
                );
            } finally {
                Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            }
        });

        test('should create correct watch patterns on POSIX', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

            try {
                const env = createMockEnvironment({ sysPrefix: '/home/test/env' });
                const packageManager = createMockPackageManager();

                watchPackageChangesForEnvironment(
                    env,
                    packageManager as PackageManager,
                    mockLogOutputChannel as LogOutputChannel,
                );

                const firstCall = createFileSystemWatcherStub.getCall(0);
                const pattern = firstCall.args[0] as RelativePattern;

                assert.ok(pattern.baseUri.fsPath.includes('lib'), 'Should use lib for POSIX');
                assert.strictEqual(
                    pattern.pattern,
                    'python*/site-packages/**/*.dist-info/METADATA',
                    'Should watch .dist-info METADATA files with python* glob',
                );
            } finally {
                Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            }
        });

        test('should append package-manager-provided watch targets to defaults', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment({ sysPrefix: '/path/to/env' });
            const packageManager = createMockPackageManager();
            (packageManager as PackageManager).getPackageWatchTargets = () => [
                new RelativePattern('/path/to/env/conda-meta', '**/*.json'),
            ];

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            assert.strictEqual(createFileSystemWatcherStub.callCount, 2, 'Should watch default and custom targets');

            const firstCall = createFileSystemWatcherStub.getCall(0);
            const firstPattern = firstCall.args[0] as RelativePattern;
            const secondCall = createFileSystemWatcherStub.getCall(1);
            const secondPattern = secondCall.args[0] as RelativePattern;

            assert.ok(
                firstPattern.pattern.endsWith('site-packages/**/*.dist-info/METADATA'),
                'Should keep default site-packages watcher',
            );
            assert.ok(secondPattern.baseUri.fsPath.includes('conda-meta'), 'Should append conda-meta target');
            assert.strictEqual(secondPattern.pattern, '**/*.json', 'Should watch JSON files in conda-meta');
        });

        test('should call packageManager.refresh on file create', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Verify watcher is created and create events are observed.
            assert.strictEqual(createFileSystemWatcherStub.callCount, 1, 'Should create watcher for site-packages');
            assert.strictEqual(createFileSystemWatcherStub.getCall(0).args[1], false, 'Should watch create events');
        });

        test('should call packageManager.refresh on file delete', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Verify watcher is created and delete events are observed.
            assert.strictEqual(createFileSystemWatcherStub.callCount, 1, 'Should create watcher for site-packages');
            assert.strictEqual(createFileSystemWatcherStub.getCall(0).args[3], false, 'Should watch delete events');
        });

        test('should debounce multiple rapid file events', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Verify watcher is created with event handlers for debouncing.
            assert.strictEqual(
                createFileSystemWatcherStub.callCount,
                1,
                'Should create watcher with debounced event handlers',
            );
        });

        test('should dispose watchers when disposable is disposed', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            const disposable = watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            disposable.dispose();

            // Should dispose all watchers
            assert.ok((mockWatcher.dispose as sinon.SinonStub).called, 'Watcher should be disposed');
        });

        test('should return empty disposable when environment has no sysPrefix', () => {
            const env = createMockEnvironment({ sysPrefix: undefined });
            const packageManager = createMockPackageManager();

            const disposable = watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            assert.ok(disposable, 'Should return a disposable');
            // Should not create any watchers
            assert.strictEqual(
                createFileSystemWatcherStub.callCount,
                0,
                'Should not create watchers when sysPrefix is missing',
            );
        });
    });

    suite('registerPackageWatcherForManager', () => {
        test('should create watcher for active environment on startup', async () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const changeEmitter = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const envManager = createMockEnvironmentManager({
                onDidChangeEnvironment: changeEmitter.event,
            });
            const packageManager = createMockPackageManager();

            await registerPackageWatcherForManager(
                envManager as EnvironmentManager,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Simulate environment change to active environment
            changeEmitter.fire({
                uri: env.environmentPath,
                new: env,
                old: undefined,
            });

            // Should create watchers for the environment
            assert.ok(createFileSystemWatcherStub.callCount > 0, 'Should create watchers when environment is set');
        });

        test('should create new watcher when active environment changes', async () => {
            const mockWatcher1 = createMockWatcher();
            const mockWatcher2 = createMockWatcher();
            createFileSystemWatcherStub.onFirstCall().returns(mockWatcher1);
            createFileSystemWatcherStub.onSecondCall().returns(mockWatcher2);
            createFileSystemWatcherStub.returns(mockWatcher2);

            const env1 = createMockEnvironment({ envId: { id: 'env-1', managerId: 'test' } });
            const env2 = createMockEnvironment({ envId: { id: 'env-2', managerId: 'test' } });

            const changeEmitter = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const envManager = createMockEnvironmentManager({
                onDidChangeEnvironment: changeEmitter.event,
            });
            const packageManager = createMockPackageManager();

            const disposable = await registerPackageWatcherForManager(
                envManager as EnvironmentManager,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Create initial watcher for env1
            changeEmitter.fire({
                uri: env1.environmentPath,
                new: env1,
                old: undefined,
            });

            const initialCallCount = createFileSystemWatcherStub.callCount;

            // Simulate environment change to env2
            changeEmitter.fire({
                uri: env2.environmentPath,
                new: env2,
                old: env1,
            });

            // Should create new watchers for env2
            assert.ok(
                createFileSystemWatcherStub.callCount > initialCallCount,
                'Should create new watchers for new environment',
            );

            // Old watcher should be disposed
            assert.ok((mockWatcher1.dispose as sinon.SinonStub).called, 'Old watcher should be disposed');

            disposable.dispose();
        });

        test('should dispose all watchers when disposed', async () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const changeEmitter = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const envManager = createMockEnvironmentManager({
                onDidChangeEnvironment: changeEmitter.event,
            });
            const packageManager = createMockPackageManager();

            const disposable = await registerPackageWatcherForManager(
                envManager as EnvironmentManager,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Simulate environment change to setup watcher
            changeEmitter.fire({
                uri: env.environmentPath,
                new: env,
                old: undefined,
            });

            disposable.dispose();

            // Should dispose watchers
            assert.ok((mockWatcher.dispose as sinon.SinonStub).called, 'Watchers should be disposed');
        });

        test('should not create duplicate watchers for same environment', async () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment({ envId: { id: 'env-1', managerId: 'test' } });

            const changeEmitter = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const envManager = createMockEnvironmentManager({
                onDidChangeEnvironment: changeEmitter.event,
            });
            const packageManager = createMockPackageManager();

            const disposable = await registerPackageWatcherForManager(
                envManager as EnvironmentManager,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Set watcher for env1
            changeEmitter.fire({
                uri: env.environmentPath,
                new: env,
                old: undefined,
            });

            const initialCallCount = createFileSystemWatcherStub.callCount;

            // Fire another change for the same environment
            changeEmitter.fire({
                uri: env.environmentPath,
                new: env,
                old: env,
            });

            // Should not create new watchers
            assert.strictEqual(
                createFileSystemWatcherStub.callCount,
                initialCallCount,
                'Should not create duplicate watchers for same envId',
            );

            disposable.dispose();
        });
    });
});
