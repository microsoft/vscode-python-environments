// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import {
    Disposable,
    Event,
    GlobalEnvironmentVariableCollection,
    Uri,
    WorkspaceConfiguration,
    WorkspaceFolder,
    workspace,
} from 'vscode';
import * as workspaceApis from '../../common/workspace.apis';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';

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

    const testWorkspacePath = '/test/workspace';
    const testWorkspaceFolder = createMockWorkspaceFolder(testWorkspacePath, 'test', 0);

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        workspaceFoldersValue = [testWorkspaceFolder];
        Object.defineProperty(workspace, 'workspaceFolders', {
            get: () => workspaceFoldersValue,
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

    suite('useEnvFile=false (Issue #936)', () => {
        test('should NOT inject env vars when useEnvFile is false', async () => {
            getConfigurationStub.returns(createMockConfig({ useEnvFile: false }) as WorkspaceConfiguration);
            envVarManager
                .setup((m) => m.getEnvironmentVariables(typeMoq.It.isAny()))
                .returns(() => Promise.resolve({ TEST_VAR: 'test_value', API_KEY: 'secret123' }));

            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(mockScopedCollection.replace.called, false);
        });

        test('should NOT inject when useEnvFile is false even with python.envFile configured', async () => {
            getConfigurationStub.returns(
                createMockConfig({
                    useEnvFile: false,
                    envFilePath: '${workspaceFolder}/.env.local',
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

    suite('python.envFile compatibility', () => {
        test('python.envFile has no effect when useEnvFile is false', async () => {
            getConfigurationStub.returns(
                createMockConfig({
                    useEnvFile: false,
                    envFilePath: '${workspaceFolder}/.env.production',
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
            const pathConfigs = [undefined, '', '.env', '.env.local', '${workspaceFolder}/.env', '/absolute/path/.env'];

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
});
