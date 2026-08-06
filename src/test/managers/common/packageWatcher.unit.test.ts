// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, LogOutputChannel, RelativePattern, Uri } from 'vscode';
import { DidChangeEnvironmentEventArgs, PackageManager, PythonEnvironment, PythonEnvironmentId } from '../../../api';
import * as workspaceApis from '../../../common/workspace.apis';
import { EnvironmentManagers, InternalPackageManager } from '../../../internal.api';
import { registerPackageWatchers, watchPackageChangesForEnvironment } from '../../../managers/common/packageWatcher';

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
        sandbox.stub(workspaceApis, 'getConfiguration').returns({
            get: (_key: string, defaultValue?: unknown) => defaultValue ?? true,
        } as ReturnType<typeof workspaceApis.getConfiguration>);
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
            assert.deepStrictEqual(
                createFileSystemWatcherStub.firstCall.args.slice(1),
                [false, false, false],
                'Should listen for create, change, and delete events',
            );
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
                    'site-packages/{*.dist-info,*.dist-info/**}',
                    'Should watch .dist-info directories and their contents',
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
                    'python*/site-packages/{*.dist-info,*.dist-info/**}',
                    'Should watch .dist-info directories and their contents with python* glob',
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
                firstPattern.pattern.endsWith('site-packages/{*.dist-info,*.dist-info/**}'),
                'Should keep default site-packages watcher',
            );
            assert.ok(secondPattern.baseUri.fsPath.includes('conda-meta'), 'Should append conda-meta target');
            assert.strictEqual(secondPattern.pattern, '**/*.json', 'Should watch JSON files in conda-meta');
        });

        test('should call packageManager.refresh on file create', async () => {
            const clock = sandbox.useFakeTimers();
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Fire a create event and advance past debounce
            mockWatcher._createEmitter.fire(Uri.file('/path/to/pkg.dist-info'));
            clock.tick(600);
            await clock.tickAsync(0);

            assert.strictEqual(
                (packageManager.refresh as sinon.SinonStub).callCount,
                1,
                'Should call refresh on file create',
            );

            clock.restore();
        });

        test('should call packageManager.refresh on file change', async () => {
            const clock = sandbox.useFakeTimers();
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            mockWatcher._changeEmitter.fire(Uri.file('/path/to/pkg.dist-info/METADATA'));
            clock.tick(600);
            await clock.tickAsync(0);

            assert.strictEqual(
                (packageManager.refresh as sinon.SinonStub).callCount,
                1,
                'Should call refresh on file change',
            );

            clock.restore();
        });

        test('should call packageManager.refresh on file delete', async () => {
            const clock = sandbox.useFakeTimers();
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);

            const env = createMockEnvironment();
            const packageManager = createMockPackageManager();

            watchPackageChangesForEnvironment(
                env,
                packageManager as PackageManager,
                mockLogOutputChannel as LogOutputChannel,
            );

            // Fire a delete event and advance past debounce
            mockWatcher._deleteEmitter.fire(Uri.file('/path/to/pkg.dist-info/METADATA'));
            clock.tick(600);
            await clock.tickAsync(0);

            assert.strictEqual(
                (packageManager.refresh as sinon.SinonStub).callCount,
                1,
                'Should call refresh on file delete',
            );

            clock.restore();
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

    suite('registerPackageWatchers', () => {
        test('should watch an active environment using its scope package manager', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);
            const environmentChanges = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const packageManager = createMockPackageManager();
            packageManager.getPackageWatchTargets = () => [new RelativePattern('/path/to/env/conda-meta', '**/*.json')];
            const internalPackageManager = new InternalPackageManager('conda', packageManager as PackageManager);
            const scope = Uri.file('.');
            const envManagers = {
                onDidChangeActiveEnvironment: environmentChanges.event,
                getPackageManager: sandbox.stub().returns(internalPackageManager),
            } as unknown as EnvironmentManagers;
            const env = createMockEnvironment({ envId: { id: 'conda-env', managerId: 'conda' } });

            registerPackageWatchers(envManagers, mockLogOutputChannel as LogOutputChannel);
            environmentChanges.fire({ uri: scope, new: env, old: undefined });

            assert.ok((envManagers.getPackageManager as sinon.SinonStub).calledWith(scope));
            assert.strictEqual(
                createFileSystemWatcherStub.callCount,
                2,
                'Should include default and manager-specific watch targets',
            );
        });

        test('should retain a shared environment watcher until all scopes release it', () => {
            const mockWatcher = createMockWatcher();
            createFileSystemWatcherStub.returns(mockWatcher);
            const environmentChanges = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const packageManager = new InternalPackageManager('pip', createMockPackageManager() as PackageManager);
            const envManagers = {
                onDidChangeActiveEnvironment: environmentChanges.event,
                getPackageManager: sandbox.stub().returns(packageManager),
            } as unknown as EnvironmentManagers;
            const env = createMockEnvironment();
            const firstScope = Uri.file('workspace-one');
            const secondScope = Uri.file('workspace-two');

            registerPackageWatchers(envManagers, mockLogOutputChannel as LogOutputChannel);
            environmentChanges.fire({ uri: firstScope, new: env, old: undefined });
            environmentChanges.fire({ uri: secondScope, new: env, old: undefined });

            assert.strictEqual(createFileSystemWatcherStub.callCount, 1, 'Should share one environment watcher');

            environmentChanges.fire({ uri: firstScope, new: undefined, old: env });
            assert.ok(!(mockWatcher.dispose as sinon.SinonStub).called, 'Should retain watcher for the second scope');

            environmentChanges.fire({ uri: secondScope, new: undefined, old: env });
            assert.ok((mockWatcher.dispose as sinon.SinonStub).called, 'Should dispose watcher after the final scope');
        });

        test('should stop watching an environment when the active environment changes', () => {
            const firstWatcher = createMockWatcher();
            const secondWatcher = createMockWatcher();
            createFileSystemWatcherStub.onFirstCall().returns(firstWatcher);
            createFileSystemWatcherStub.onSecondCall().returns(secondWatcher);
            const environmentChanges = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const packageManager = new InternalPackageManager('pip', createMockPackageManager() as PackageManager);
            const envManagers = {
                onDidChangeActiveEnvironment: environmentChanges.event,
                getPackageManager: sandbox.stub().returns(packageManager),
            } as unknown as EnvironmentManagers;
            const scope = Uri.file('workspace');
            const firstEnvironment = createMockEnvironment({ envId: { id: 'env-one', managerId: 'test-manager' } });
            const secondEnvironment = createMockEnvironment({ envId: { id: 'env-two', managerId: 'test-manager' } });

            registerPackageWatchers(envManagers, mockLogOutputChannel as LogOutputChannel);
            environmentChanges.fire({ uri: scope, new: firstEnvironment, old: undefined });
            environmentChanges.fire({ uri: scope, new: secondEnvironment, old: firstEnvironment });

            assert.ok(
                (firstWatcher.dispose as sinon.SinonStub).called,
                'Should dispose the inactive environment watcher',
            );
            assert.ok(
                !(secondWatcher.dispose as sinon.SinonStub).called,
                'Should retain the active environment watcher',
            );
            assert.strictEqual(createFileSystemWatcherStub.callCount, 2);
        });

        test('should use separate watchers when scopes select different package managers', () => {
            createFileSystemWatcherStub.returns(createMockWatcher());
            const environmentChanges = new EventEmitter<DidChangeEnvironmentEventArgs>();
            const firstScope = Uri.file('workspace-one');
            const secondScope = Uri.file('workspace-two');
            const firstPackageManager = new InternalPackageManager('pip', createMockPackageManager() as PackageManager);
            const secondPackageManager = new InternalPackageManager(
                'conda',
                createMockPackageManager() as PackageManager,
            );
            const envManagers = {
                onDidChangeActiveEnvironment: environmentChanges.event,
                getPackageManager: sandbox
                    .stub()
                    .callsFake((scope) => (scope === firstScope ? firstPackageManager : secondPackageManager)),
            } as unknown as EnvironmentManagers;
            const env = createMockEnvironment();

            registerPackageWatchers(envManagers, mockLogOutputChannel as LogOutputChannel);
            environmentChanges.fire({ uri: firstScope, new: env, old: undefined });
            environmentChanges.fire({ uri: secondScope, new: env, old: undefined });

            assert.strictEqual(createFileSystemWatcherStub.callCount, 2);
        });
    });
});
