// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { GlobalEnvironmentVariableCollection, Uri, workspace, WorkspaceFolder } from 'vscode';
import * as workspaceApis from '../../common/workspace.apis';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';

interface MockScopedCollection {
    clear: sinon.SinonStub;
    replace: sinon.SinonStub;
    delete: sinon.SinonStub;
}

suite('TerminalEnvVarInjector Basic Tests', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;
    let mockScopedCollection: MockScopedCollection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let workspaceFoldersStub: any;

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        // Mock workspace.workspaceFolders property
        workspaceFoldersStub = [];
        Object.defineProperty(workspace, 'workspaceFolders', {
            get: () => workspaceFoldersStub,
            configurable: true,
        });

        // Setup scoped collection mock
        mockScopedCollection = {
            clear: sinon.stub(),
            replace: sinon.stub(),
            delete: sinon.stub(),
        };

        // Setup environment variable collection to return scoped collection
        envVarCollection
            .setup((x) => x.getScoped(typeMoq.It.isAny()))
            .returns(
                () => mockScopedCollection as unknown as ReturnType<GlobalEnvironmentVariableCollection['getScoped']>,
            );
        envVarCollection.setup((x) => x.clear()).returns(() => {});

        // Setup minimal mocks for event subscriptions
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns(
                () =>
                    ({
                        dispose: () => {},
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    }) as any,
            );
        // Mock workspace.onDidChangeConfiguration to return a proper disposable
        Object.defineProperty(workspace, 'onDidChangeConfiguration', {
            value: () => ({ dispose: () => {} }),
            configurable: true,
            writable: true,
        });
    });

    teardown(() => {
        sinon.restore();
        injector?.dispose();
    });

    test('should initialize without errors', () => {
        // Arrange & Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert - should not throw
        sinon.assert.match(injector, sinon.match.object);
    });

    test('should dispose cleanly', () => {
        // Arrange
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Act
        injector.dispose();

        // Assert - should clear on dispose
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.atLeastOnce());
    });

    test('should register environment variable change event handler', () => {
        // Arrange
        let eventHandlerRegistered = false;
        envVarManager.reset();
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((_handler) => {
                eventHandlerRegistered = true;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });
});

/**
 * Tests for variable clearing: Ensure that when .env file variables are commented out or removed,
 * they are properly removed from the terminal environment.
 *
 * These tests verify the clear() behavior when useEnvFile setting is disabled.
 * Tests for file-existence scenarios are integration-level and not covered here.
 */
suite('TerminalEnvVarInjector - Variable Clearing', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let injector: TerminalEnvVarInjector;
    let mockScopedCollection: MockScopedCollection;
    let mockGetConfiguration: sinon.SinonStub;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let workspaceFoldersStub: any;
    let mockWorkspaceFolder: WorkspaceFolder;
    let mockEnvVarManager: {
        onDidChangeEnvironmentVariables: sinon.SinonStub;
        getEnvironmentVariables: sinon.SinonStub;
    };

    interface MockWorkspaceConfig {
        get: sinon.SinonStub;
    }

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();

        // Create mock EnvVarManager using sinon stubs
        mockEnvVarManager = {
            onDidChangeEnvironmentVariables: sinon.stub().returns({ dispose: () => {} }),
            getEnvironmentVariables: sinon.stub().resolves({}),
        };

        // Create a mock workspace folder
        mockWorkspaceFolder = {
            uri: Uri.file('/test/workspace'),
            name: 'test-workspace',
            index: 0,
        };

        // Mock workspace.workspaceFolders property
        workspaceFoldersStub = [mockWorkspaceFolder];
        Object.defineProperty(workspace, 'workspaceFolders', {
            get: () => workspaceFoldersStub,
            configurable: true,
        });

        // Setup scoped collection mock
        mockScopedCollection = {
            clear: sinon.stub(),
            replace: sinon.stub(),
            delete: sinon.stub(),
        };

        // Setup environment variable collection to return scoped collection
        envVarCollection
            .setup((x) => x.getScoped(typeMoq.It.isAny()))
            .returns(
                () => mockScopedCollection as unknown as ReturnType<GlobalEnvironmentVariableCollection['getScoped']>,
            );
        envVarCollection.setup((x) => x.clear()).returns(() => {});

        // Mock getConfiguration
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');

        // Mock workspace.onDidChangeConfiguration to return a proper disposable
        Object.defineProperty(workspace, 'onDidChangeConfiguration', {
            value: () => ({ dispose: () => {} }),
            configurable: true,
            writable: true,
        });
    });

    teardown(() => {
        sinon.restore();
        injector?.dispose();
    });

    test('should call clear() when useEnvFile setting is disabled', async () => {
        // Arrange - mock configuration with useEnvFile disabled
        const mockConfig: MockWorkspaceConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns(undefined);
        mockGetConfiguration.returns(mockConfig);

        // Mock getEnvironmentVariables
        mockEnvVarManager.getEnvironmentVariables.resolves({ TEST_VAR: 'value' });

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, mockEnvVarManager as unknown as EnvVarManager);

        // Wait for async initialization
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Assert - clear() should be called, but replace() should NOT be called
        sinon.assert.called(mockScopedCollection.clear);
        sinon.assert.notCalled(mockScopedCollection.replace);
    });

    test('should not inject variables when useEnvFile is disabled even if env vars exist', async () => {
        // Arrange - mock configuration with useEnvFile disabled
        const mockConfig: MockWorkspaceConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns('.env');
        mockGetConfiguration.returns(mockConfig);

        // Mock getEnvironmentVariables to return multiple variables
        mockEnvVarManager.getEnvironmentVariables.resolves({
            API_KEY: 'secret123',
            DATABASE_URL: 'postgres://localhost/db',
            DEBUG: 'true',
        });

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, mockEnvVarManager as unknown as EnvVarManager);

        // Wait for async initialization
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Assert - clear() should be called to remove any previous variables, but replace() should NOT be called
        sinon.assert.called(mockScopedCollection.clear);
        sinon.assert.notCalled(mockScopedCollection.replace);
    });
});
