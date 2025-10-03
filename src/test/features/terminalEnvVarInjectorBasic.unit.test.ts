// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Disposable, GlobalEnvironmentVariableCollection, workspace, WorkspaceFolder } from 'vscode';
import { DidChangeEnvironmentVariablesEventArgs } from '../../api';
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
    let workspaceFoldersStub: WorkspaceFolder[];

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
        envVarCollection.setup((x) => x.getScoped(typeMoq.It.isAny())).returns(() => mockScopedCollection as never);
        envVarCollection.setup((x) => x.clear()).returns(() => {});

        // Setup minimal mocks for event subscriptions
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns(() => {
                // Return a mock Event function that returns a Disposable when called
                const mockEvent = (_listener: (e: DidChangeEnvironmentVariablesEventArgs) => void) =>
                    ({
                        dispose: () => {},
                    } as Disposable);
                return mockEvent;
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
            .returns(() => {
                eventHandlerRegistered = true;
                // Return a mock Event function that returns a Disposable when called
                const mockEvent = (_listener: (e: DidChangeEnvironmentVariablesEventArgs) => void) =>
                    ({
                        dispose: () => {},
                    } as Disposable);
                return mockEvent;
            });

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Assert
        sinon.assert.match(eventHandlerRegistered, true);
    });
});
