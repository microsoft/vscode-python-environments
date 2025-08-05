// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Uri, workspace, GlobalEnvironmentVariableCollection, WorkspaceFolder } from 'vscode';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import * as workspaceApis from '../../common/workspace.apis';

interface MockScopedCollection {
    clear: sinon.SinonStub;
    replace: sinon.SinonStub;
    delete: sinon.SinonStub;
}

suite('TerminalEnvVarInjector Tests', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;
    let getWorkspaceFolderStub: sinon.SinonStub;
    let workspaceFoldersStub: any;
    let mockScopedCollection: MockScopedCollection;

    const testWorkspaceUri = Uri.file('/test/workspace');
    const testWorkspaceFolder: WorkspaceFolder = { uri: testWorkspaceUri, name: 'test', index: 0 };

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        // Mock workspace APIs
        getWorkspaceFolderStub = sinon.stub(workspaceApis, 'getWorkspaceFolder');
        
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
            delete: sinon.stub()
        };

        // Setup environment variable collection to return scoped collection
        envVarCollection.setup(x => x.getScoped(typeMoq.It.isAny())).returns(() => mockScopedCollection as any);
        envVarCollection.setup(x => x.clear()).returns(() => {});

        // Setup default mocks
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns(() => ({
            dispose: () => {},
        }) as any);
    });

    teardown(() => {
        sinon.restore();
        injector?.dispose();
    });

    test('should create injector instance without errors', () => {
        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert - should not throw
        sinon.assert.match(injector, sinon.match.object);
    });

    test('should register event handler for environment variable changes', () => {
        // Arrange
        let eventHandlerRegistered = false;
        envVarManager.reset();
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns((_callback) => {
            eventHandlerRegistered = true;
            return { dispose: () => {} } as any;
        });

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });

    test('should handle environment variable changes for specific workspace', () => {
        // Arrange
        let eventHandlerRegistered = false;
        envVarManager.reset();
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns((callback) => {
            eventHandlerRegistered = true;
            // Simulate calling the callback immediately for specific workspace
            try {
                callback({ uri: testWorkspaceUri, changeType: 1 });
            } catch (error) {
                throw new Error(`Event handler threw an error: ${error}`);
            }
            return { dispose: () => {} } as any;
        });

        getWorkspaceFolderStub.withArgs(testWorkspaceUri).returns(testWorkspaceFolder);

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });

    test('should handle file deletion events', () => {
        // Arrange
        let eventHandlerRegistered = false;
        envVarManager.reset();
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns((callback) => {
            eventHandlerRegistered = true;
            // Simulate calling the callback immediately for file deletion
            try {
                callback({ uri: testWorkspaceUri, changeType: 2 }); // FileChangeType.Deleted
            } catch (error) {
                throw new Error(`Event handler threw an error during file deletion: ${error}`);
            }
            return { dispose: () => {} } as any;
        });

        getWorkspaceFolderStub.withArgs(testWorkspaceUri).returns(testWorkspaceFolder);

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });

    test('should handle changes when no specific URI is provided', () => {
        // Arrange
        let eventHandlerRegistered = false;
        envVarManager.reset();
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns((callback) => {
            eventHandlerRegistered = true;
            // Simulate calling the callback immediately for global change
            try {
                callback({ uri: undefined, changeType: 1 });
            } catch (error) {
                throw new Error(`Event handler threw an error during global change: ${error}`);
            }
            return { dispose: () => {} } as any;
        });

        workspaceFoldersStub = [];

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });

    test('should handle changes when no workspace folder is found for URI', () => {
        // Arrange
        let eventHandlerRegistered = false;
        envVarManager.reset();
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns((callback) => {
            eventHandlerRegistered = true;
            // Simulate calling the callback immediately for missing workspace folder
            try {
                callback({ uri: testWorkspaceUri, changeType: 1 });
            } catch (error) {
                throw new Error(`Event handler threw an error when workspace folder not found: ${error}`);
            }
            return { dispose: () => {} } as any;
        });

        getWorkspaceFolderStub.withArgs(testWorkspaceUri).returns(undefined);
        workspaceFoldersStub = [];

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });

    test('should dispose cleanly', () => {
        // Arrange
        workspaceFoldersStub = [];
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Act
        injector.dispose();

        // Assert
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.atLeastOnce());
    });
});