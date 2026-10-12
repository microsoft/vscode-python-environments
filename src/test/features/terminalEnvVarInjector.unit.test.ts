// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import fse from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import {
    ConfigurationTarget,
    Disposable,
    Event,
    GlobalEnvironmentVariableCollection,
    Uri,
    WorkspaceConfiguration,
    WorkspaceFolder,
    workspace,
} from 'vscode';
import { ActivationStrings, Common } from '../../common/localize';
import * as logging from '../../common/logging';
import * as persistentState from '../../common/persistentState';
import { createDeferred } from '../../common/utils/deferred';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import {
    ENV_FILE_NOTIFICATION_DONT_SHOW_KEY,
    TerminalEnvVarInjector,
} from '../../features/terminal/terminalEnvVarInjector';

interface MockScopedCollection {
    clear: sinon.SinonStub;
    replace: sinon.SinonStub;
    delete: sinon.SinonStub;
}

function createMockConfig(settings: { useEnvFile?: boolean; envFilePath?: string }): Partial<WorkspaceConfiguration> {
    return {
        get: <T>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'terminal.useEnvFile') {
                return (settings.useEnvFile ?? false) as T;
            }
            if (key === 'envFile') {
                return settings.envFilePath as T;
            }
            return defaultValue;
        },
    };
}

function createMockWorkspaceFolder(fsPath: string, name: string, index: number): WorkspaceFolder {
    return { uri: Uri.file(fsPath), name, index };
}

function createMockEvent<T>(): Event<T> {
    return (_listener: (e: T) => void): Disposable => new Disposable(() => {});
}

suite('TerminalEnvVarInjector', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;
    let mockScopedCollection: MockScopedCollection;
    let getConfigurationStub: sinon.SinonStub;
    let workspaceFoldersValue: readonly WorkspaceFolder[] | undefined;

    const testWorkspacePath = path.resolve('test', 'workspace');
    const testWorkspaceFolder = createMockWorkspaceFolder(testWorkspacePath, 'test', 0);

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        workspaceFoldersValue = [testWorkspaceFolder];
        Object.defineProperty(workspace, 'workspaceFolders', {
            get: () => workspaceFoldersValue,
            configurable: true,
        });

        // Mock workspace.onDidChangeConfiguration to return a proper disposable
        Object.defineProperty(workspace, 'onDidChangeConfiguration', {
            value: () => new Disposable(() => {}),
            configurable: true,
        });

        mockScopedCollection = {
            clear: sinon.stub(),
            replace: sinon.stub(),
            delete: sinon.stub(),
        };

        envVarCollection
            .setup((x) => x.getScoped(typeMoq.It.isAny()))
            .returns(
                () => mockScopedCollection as unknown as ReturnType<GlobalEnvironmentVariableCollection['getScoped']>,
            );
        envVarCollection.setup((x) => x.clear()).returns(() => {});

        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns(() => createMockEvent());

        getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration');
        getConfigurationStub.returns(createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration);
    });

    teardown(() => {
        sinon.restore();
        try {
            injector?.dispose();
        } catch {
            // Ignore disposal errors
        }
    });

    suite('Basic functionality', () => {
        test('should initialize without errors', () => {
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            sinon.assert.match(injector, sinon.match.object);
        });

        test('should dispose cleanly', () => {
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            injector.dispose();
            envVarCollection.verify((c) => c.clear(), typeMoq.Times.atLeastOnce());
        });

        test('should register environment variable change event handler', () => {
            let eventHandlerRegistered = false;
            envVarManager.reset();
            envVarManager
                .setup((m) => m.onDidChangeEnvironmentVariables)
                .returns(() => {
                    eventHandlerRegistered = true;
                    return createMockEvent();
                });

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            sinon.assert.match(eventHandlerRegistered, true);
        });
    });

    suite('useEnvFile=false', () => {
        test('should NOT inject env vars when useEnvFile is false', async () => {
            getConfigurationStub.returns(createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration);
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ TEST_VAR: 'test_value', API_KEY: 'secret123' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(mockScopedCollection.replace.called, false);
        });

        suite('env file changes', () => {
            let envChangeCallback: ((args: { uri?: Uri; changeType: number }) => Promise<void>) | undefined;
            let variables: Record<string, string>;
            let variableReads: Promise<Record<string, string>>[];
            let existingFiles: Set<string>;
            const defaultEnvFile = path.join(testWorkspaceFolder.uri.fsPath, '.env');
            const configuredEnvFile = path.join(testWorkspaceFolder.uri.fsPath, 'configured.env');

            setup(() => {
                variables = {};
                variableReads = [];
                existingFiles = new Set();
                workspaceFoldersValue = undefined;
                sinon
                    .stub(fse, 'pathExists')
                    .callsFake(async (filePath) => existingFiles.has(path.resolve(filePath.toString())));
                sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(testWorkspaceFolder);
                envVarManager.reset();
                envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns(
                    () => (listener) => {
                        envChangeCallback = listener;
                        return new Disposable(() => {});
                    },
                );
                envVarManager
                    .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                    .returns(() => variableReads.shift() ?? Promise.resolve({ ...variables }));
            });

            async function fireChange(changeType: number, filePath = defaultEnvFile): Promise<void> {
                assert.ok(envChangeCallback);
                await envChangeCallback({ uri: Uri.file(filePath), changeType });
            }

            test('creating an env file with injection disabled preserves shell activation variables', async () => {
                getConfigurationStub.returns(createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration);
                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
                await fireChange(2);

                sinon.assert.notCalled(mockScopedCollection.clear);
                sinon.assert.notCalled(mockScopedCollection.delete);
                sinon.assert.notCalled(mockScopedCollection.replace);
            });

            test('creating, editing, and deleting an env file updates only its injected variables', async () => {
                getConfigurationStub.returns(createMockConfig({ useEnvFile: true }) as WorkspaceConfiguration);
                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

                existingFiles.add(defaultEnvFile);
                variables = { TERMINAL_PROBE_VALUE: 'created' };
                await fireChange(2);
                sinon.assert.calledWith(mockScopedCollection.replace, 'TERMINAL_PROBE_VALUE', 'created');

                variables = { OTHER_VALUE: 'edited' };
                await fireChange(1);
                sinon.assert.calledWith(mockScopedCollection.delete, 'TERMINAL_PROBE_VALUE');
                sinon.assert.calledWith(mockScopedCollection.replace, 'OTHER_VALUE', 'edited');

                existingFiles.delete(defaultEnvFile);
                variables = {};
                await fireChange(3);
                sinon.assert.calledWith(mockScopedCollection.delete, 'OTHER_VALUE');
                sinon.assert.notCalled(mockScopedCollection.clear);
            });

            test('deleting one env file retains variables from the other configured file', async () => {
                getConfigurationStub.returns(
                    createMockConfig({ useEnvFile: true, envFilePath: configuredEnvFile }) as WorkspaceConfiguration,
                );
                existingFiles.add(defaultEnvFile);
                existingFiles.add(configuredEnvFile);
                variables = { CONFIGURED_VALUE: 'configured', PROJECT_VALUE: 'project' };
                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
                await fireChange(2, configuredEnvFile);

                existingFiles.delete(configuredEnvFile);
                variables = { PROJECT_VALUE: 'project' };
                await fireChange(3, configuredEnvFile);

                sinon.assert.calledWith(mockScopedCollection.delete, 'CONFIGURED_VALUE');
                sinon.assert.neverCalledWith(mockScopedCollection.delete, 'PROJECT_VALUE');
                sinon.assert.notCalled(mockScopedCollection.clear);
            });

            test('deleting the project env file retains variables from the configured file', async () => {
                getConfigurationStub.returns(
                    createMockConfig({ useEnvFile: true, envFilePath: configuredEnvFile }) as WorkspaceConfiguration,
                );
                existingFiles.add(defaultEnvFile);
                existingFiles.add(configuredEnvFile);
                variables = { CONFIGURED_VALUE: 'configured', PROJECT_VALUE: 'project' };
                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
                await fireChange(2);

                existingFiles.delete(defaultEnvFile);
                variables = { CONFIGURED_VALUE: 'configured' };
                await fireChange(3);

                sinon.assert.calledWith(mockScopedCollection.delete, 'PROJECT_VALUE');
                sinon.assert.neverCalledWith(mockScopedCollection.delete, 'CONFIGURED_VALUE');
                sinon.assert.notCalled(mockScopedCollection.clear);
            });

            test('does not let an older env file refresh overwrite newer variables', async () => {
                getConfigurationStub.returns(createMockConfig({ useEnvFile: true }) as WorkspaceConfiguration);
                existingFiles.add(defaultEnvFile);
                const olderRefresh = createDeferred<Record<string, string>>();
                const newerRefresh = createDeferred<Record<string, string>>();
                variableReads.push(olderRefresh.promise, newerRefresh.promise);
                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

                assert.ok(envChangeCallback);
                const firstChange = envChangeCallback({ uri: Uri.file(defaultEnvFile), changeType: 3 });
                const secondChange = envChangeCallback({ uri: Uri.file(defaultEnvFile), changeType: 2 });

                newerRefresh.resolve({ NEW_VALUE: 'new' });
                await secondChange;
                olderRefresh.resolve({ OLD_VALUE: 'old' });
                await firstChange;

                sinon.assert.calledOnceWithExactly(mockScopedCollection.replace, 'NEW_VALUE', 'new');
                sinon.assert.neverCalledWith(mockScopedCollection.replace, 'OLD_VALUE', 'old');
            });
        });

        test('should NOT inject when useEnvFile is false even with python.envFile configured', async () => {
            getConfigurationStub.returns(
                createMockConfig({
                    useEnvFile: false,
                    envFilePath: '${workspaceFolder}/.env',
                }) as WorkspaceConfiguration,
            );
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ DATABASE_URL: 'postgres://localhost/db' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(mockScopedCollection.replace.called, false);
        });

        test('should NOT inject when useEnvFile is false with multiple workspace folders', async () => {
            const workspace1 = createMockWorkspaceFolder('/workspace1', 'workspace1', 0);
            const workspace2 = createMockWorkspaceFolder('/workspace2', 'workspace2', 1);
            workspaceFoldersValue = [workspace1, workspace2];

            getConfigurationStub.returns(createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration);
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ VAR1: 'value1' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 100));

            assert.strictEqual(mockScopedCollection.replace.called, false);
        });

        test('should handle no workspace folders gracefully', async () => {
            workspaceFoldersValue = [];
            getConfigurationStub.returns(createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration);
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ VAR: 'value' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(mockScopedCollection.replace.called, false);
        });
    });

    suite('Configuration change triggers updateEnvironmentVariables', () => {
        let configChangeCallback: ((e: { affectsConfiguration(section: string): boolean }) => void) | undefined;

        setup(() => {
            // Capture the onDidChangeConfiguration listener so we can fire it manually
            Object.defineProperty(workspace, 'onDidChangeConfiguration', {
                value: (listener: (e: { affectsConfiguration(section: string): boolean }) => void) => {
                    configChangeCallback = listener;
                    return new Disposable(() => {});
                },
                configurable: true,
            });
        });

        test('should call updateEnvironmentVariables when python.terminal.useEnvFile changes', async () => {
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ VAR: 'value' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            // getEnvironmentVariables is called once during initialization
            envVarManager.verify(
                (m) => m.getEnvironmentVariables(typeMoq.It.isAny()),
                typeMoq.Times.once(),
            );

            // Fire config change for python.terminal.useEnvFile
            assert.ok(configChangeCallback, 'onDidChangeConfiguration listener should be registered');
            configChangeCallback!({
                affectsConfiguration: (section: string) => section === 'python.terminal.useEnvFile',
            });

            await new Promise((resolve) => setTimeout(resolve, 50));

            // Should have been called again after the config change
            envVarManager.verify(
                (m) => m.getEnvironmentVariables(typeMoq.It.isAny()),
                typeMoq.Times.exactly(2),
            );
        });

        test('should call updateEnvironmentVariables when python.envFile changes', async () => {
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ VAR: 'value' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            envVarManager.verify(
                (m) => m.getEnvironmentVariables(typeMoq.It.isAny()),
                typeMoq.Times.once(),
            );

            // Fire config change for python.envFile
            configChangeCallback!({
                affectsConfiguration: (section: string) => section === 'python.envFile',
            });

            await new Promise((resolve) => setTimeout(resolve, 50));

            envVarManager.verify(
                (m) => m.getEnvironmentVariables(typeMoq.It.isAny()),
                typeMoq.Times.exactly(2),
            );
        });
    });

    suite('python.envFile compatibility', () => {
        test('python.envFile has no effect when useEnvFile is false', async () => {
            getConfigurationStub.returns(
                createMockConfig({
                    useEnvFile: false,
                    envFilePath: '${workspaceFolder}/.env',
                }) as WorkspaceConfiguration,
            );
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ PRODUCTION_API_KEY: 'prod_key_123' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(mockScopedCollection.replace.called, false);
        });

        test('different envFile paths should not matter when useEnvFile is false', async () => {
            const pathConfigs = [undefined, '', '.env', '${workspaceFolder}/.env', '/absolute/path/.env'];

            for (const envFilePath of pathConfigs) {
                mockScopedCollection.replace.resetHistory();
                getConfigurationStub.returns(
                    createMockConfig({ useEnvFile: false, envFilePath }) as WorkspaceConfiguration,
                );

                envVarManager.reset();
                envVarManager
                    .setup((m) => m.onDidChangeEnvironmentVariables)
                    .returns(() => createMockEvent());
                envVarManager
                    .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                    .returns(() => Promise.resolve({ VAR: 'value' }));

                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
                await new Promise((resolve) => setTimeout(resolve, 50));

                assert.strictEqual(mockScopedCollection.replace.called, false, `Failed for envFilePath="${envFilePath}"`);

                try {
                    injector.dispose();
                } catch {
                    // Ignore
                }
            }
        });
    });

    suite('env file notification with Don\'t Show Again', () => {
        let envChangeCallback: ((args: { uri?: Uri; changeType: number }) => void) | undefined;
        let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
        let showInfoMessageStub: sinon.SinonStub;
        let updateConfigStub: sinon.SinonStub;
        let getWorkspaceFileStub: sinon.SinonStub;

        setup(() => {
            mockState = {
                get: sinon.stub(),
                set: sinon.stub().resolves(),
                clear: sinon.stub().resolves(),
            };
            sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
            showInfoMessageStub = sinon.stub(windowApis, 'showInformationMessage');
            updateConfigStub = sinon.stub().resolves();
            getWorkspaceFileStub = sinon.stub(workspaceApis, 'getWorkspaceFile').returns(undefined);

            // Capture the onDidChangeEnvironmentVariables listener
            envVarManager.reset();
            envVarManager
                .setup((m) => m.onDidChangeEnvironmentVariables)
                .returns(() => {
                    return (listener: (args: { uri?: Uri; changeType: number }) => void): Disposable => {
                        envChangeCallback = listener;
                        return new Disposable(() => {});
                    };
                });
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({}));

            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(testWorkspaceFolder);
        });

        test('should offer workspace enablement and persistent dismissal when injection is disabled', async () => {
            getConfigurationStub.returns(
                createMockConfig({ useEnvFile: false, envFilePath: '${workspaceFolder}/.env' }) as WorkspaceConfiguration,
            );
            mockState.get.resolves(false);
            showInfoMessageStub.resolves(undefined);

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(envChangeCallback, 'Event handler should be registered');
            envChangeCallback!({ uri: Uri.file(testWorkspacePath), changeType: 1 });
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(showInfoMessageStub.calledOnce, 'Should show notification');
            sinon.assert.calledOnceWithExactly(
                showInfoMessageStub,
                ActivationStrings.envFileInjectionDisabled,
                ActivationStrings.enableForWorkspace,
                Common.dontShowAgain,
            );
            sinon.assert.notCalled(mockState.set);
        });

        for (const folderScope of [false, true]) {
            test(`should enable injection only at ${folderScope ? 'folder' : 'workspace'} scope`, async () => {
                const config = {
                    ...createMockConfig({ useEnvFile: false, envFilePath: '${workspaceFolder}/.env' }),
                    update: updateConfigStub,
                };
                getConfigurationStub.returns(config);
                if (folderScope) {
                    getWorkspaceFileStub.returns(Uri.file(path.resolve('test.code-workspace')));
                }
                showInfoMessageStub.resolves(
                    folderScope ? ActivationStrings.enableForFolder : ActivationStrings.enableForWorkspace,
                );
                injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
                assert.ok(envChangeCallback);
                envChangeCallback({ uri: testWorkspaceFolder.uri, changeType: 1 });
                await new Promise<void>((resolve) => setImmediate(resolve));

                sinon.assert.calledOnceWithExactly(
                    updateConfigStub,
                    'terminal.useEnvFile',
                    true,
                    folderScope ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace,
                );
                sinon.assert.calledWith(getConfigurationStub, 'python', testWorkspaceFolder.uri);
                sinon.assert.calledOnceWithExactly(
                    showInfoMessageStub,
                    folderScope
                        ? ActivationStrings.envFileInjectionDisabledForFolder(testWorkspaceFolder.name)
                        : ActivationStrings.envFileInjectionDisabled,
                    folderScope ? ActivationStrings.enableForFolder : ActivationStrings.enableForWorkspace,
                    Common.dontShowAgain,
                );
                sinon.assert.notCalled(mockState.set);
            });
        }

        test('should not change settings or repeat the reminder after dismissal, including concurrent events', async () => {
            getConfigurationStub.returns({
                ...createMockConfig({ useEnvFile: false, envFilePath: '${workspaceFolder}/.env' }),
                update: updateConfigStub,
            });
            showInfoMessageStub.resolves(undefined);
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            assert.ok(envChangeCallback);
            envChangeCallback({ uri: testWorkspaceFolder.uri, changeType: 1 });
            envChangeCallback({ uri: testWorkspaceFolder.uri, changeType: 1 });
            await new Promise<void>((resolve) => setImmediate(resolve));
            envChangeCallback({ uri: testWorkspaceFolder.uri, changeType: 1 });
            await new Promise<void>((resolve) => setImmediate(resolve));

            sinon.assert.calledOnce(showInfoMessageStub);
            sinon.assert.notCalled(updateConfigStub);
            sinon.assert.notCalled(mockState.set);
        });

        test('should log failed setting updates without suppressing future sessions', async () => {
            const error = new Error('Settings are read-only');
            const traceErrorStub = sinon.stub(logging, 'traceError');
            updateConfigStub.rejects(error);
            getConfigurationStub.returns({
                ...createMockConfig({ useEnvFile: false, envFilePath: '${workspaceFolder}/.env' }),
                update: updateConfigStub,
            });
            showInfoMessageStub.resolves(ActivationStrings.enableForWorkspace);
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            assert.ok(envChangeCallback);
            envChangeCallback({ uri: testWorkspaceFolder.uri, changeType: 1 });
            await new Promise<void>((resolve) => setImmediate(resolve));

            sinon.assert.calledWith(traceErrorStub, sinon.match.string, error);
            sinon.assert.notCalled(mockState.set);
        });

        test('should not show notification when Don\'t Show Again was previously selected', async () => {
            getConfigurationStub.returns(
                createMockConfig({ useEnvFile: false, envFilePath: '${workspaceFolder}/.env' }) as WorkspaceConfiguration,
            );
            mockState.get.resolves(true);

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(envChangeCallback, 'Event handler should be registered');
            envChangeCallback!({ uri: Uri.file(testWorkspacePath), changeType: 1 });
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(showInfoMessageStub.notCalled, 'Should not show notification when dismissed');
        });

        test('should persist preference when Don\'t Show Again is clicked', async () => {
            getConfigurationStub.returns(
                createMockConfig({ useEnvFile: false, envFilePath: '${workspaceFolder}/.env' }) as WorkspaceConfiguration,
            );
            mockState.get.resolves(false);
            showInfoMessageStub.resolves(Common.dontShowAgain);

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(envChangeCallback, 'Event handler should be registered');
            envChangeCallback!({ uri: Uri.file(testWorkspacePath), changeType: 1 });
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(
                mockState.set.calledWith(ENV_FILE_NOTIFICATION_DONT_SHOW_KEY, true),
                'Should persist Don\'t Show Again preference',
            );
        });

        test('should not show notification when useEnvFile is true', async () => {
            getConfigurationStub.returns(
                createMockConfig({ useEnvFile: true, envFilePath: '${workspaceFolder}/.env' }) as WorkspaceConfiguration,
            );
            mockState.get.resolves(false);

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(envChangeCallback, 'Event handler should be registered');
            envChangeCallback!({ uri: Uri.file(testWorkspacePath), changeType: 1 });
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(showInfoMessageStub.notCalled, 'Should not show notification when useEnvFile is true');
        });

        test('should not show notification when no envFile is configured', async () => {
            getConfigurationStub.returns(
                createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration,
            );
            mockState.get.resolves(false);

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(envChangeCallback, 'Event handler should be registered');
            envChangeCallback!({ uri: Uri.file(testWorkspacePath), changeType: 1 });
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(showInfoMessageStub.notCalled, 'Should not show notification when no envFile configured');
        });
    });
});
