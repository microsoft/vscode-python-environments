// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import {
    Disposable,
    EnvironmentVariableCollection,
    GlobalEnvironmentVariableCollection,
    Uri,
    workspace,
    WorkspaceFolder,
} from 'vscode';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';

/**
 * Test interface to access private methods for unit testing.
 * This is preferable to using 'as any' and maintains type safety.
 */
interface TerminalEnvVarInjectorTestable {
    applyEnvVarChanges(
        envVarScope: EnvironmentVariableCollection,
        envVars: { [key: string]: string | undefined },
        workspaceKey: string,
    ): void;
    cleanupTrackedVars(envVarScope: EnvironmentVariableCollection, workspaceKey: string): void;
    clearWorkspaceVariables(workspaceFolder: WorkspaceFolder): void;
    trackedEnvVars: Map<string, Set<string>>;
    dispose(): void;
}

suite('TerminalEnvVarInjector - Core Functionality', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;
    let testableInjector: TerminalEnvVarInjectorTestable;
    let mockScopedCollection: EnvironmentVariableCollection;
    let clearStub: sinon.SinonStub;
    let replaceStub: sinon.SinonStub;
    let deleteStub: sinon.SinonStub;
    let getStub: sinon.SinonStub;
    let mockWorkspaceFolder: WorkspaceFolder;
    let workspaceFoldersStub: WorkspaceFolder[];

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        // Create mock workspace folder
        mockWorkspaceFolder = {
            uri: Uri.file('/test/workspace'),
            name: 'test-workspace',
            index: 0,
        };

        // Mock workspace.workspaceFolders property
        workspaceFoldersStub = [];
        Object.defineProperty(workspace, 'workspaceFolders', {
            get: () => workspaceFoldersStub,
            configurable: true,
        });

        // Setup scoped collection mock with sinon stubs
        clearStub = sinon.stub();
        replaceStub = sinon.stub();
        deleteStub = sinon.stub();
        getStub = sinon.stub();

        mockScopedCollection = {
            clear: clearStub,
            replace: replaceStub,
            delete: deleteStub,
            get: getStub,
        } as unknown as EnvironmentVariableCollection;

        // Setup environment variable collection to return scoped collection
        envVarCollection.setup((x) => x.getScoped(typeMoq.It.isAny())).returns(() => mockScopedCollection);
        envVarCollection.setup((x) => x.clear()).returns(() => {});

        // Setup minimal mocks for event subscriptions - return disposable when handler is registered
        const mockDisposable: Disposable = { dispose: () => {} };
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables(typeMoq.It.isAny())).returns(() => mockDisposable);
    });

    teardown(() => {
        sinon.restore();
        injector?.dispose();
    });

    suite('applyEnvVarChanges', () => {
        setup(() => {
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            testableInjector = injector as unknown as TerminalEnvVarInjectorTestable;
        });

        test('should add new variables from .env file', () => {
            // Mock - new variables
            const envVars = {
                FOO: 'bar',
                BAZ: 'qux',
            };

            // Run - access private method via test interface
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, '/test/workspace');

            // Assert - should call replace for each variable
            assert.ok(replaceStub.calledWith('FOO', 'bar'), 'Should set FOO');
            assert.ok(replaceStub.calledWith('BAZ', 'qux'), 'Should set BAZ');
            assert.strictEqual(replaceStub.callCount, 2, 'Should set exactly 2 variables');
        });

        test('should update existing variables', () => {
            // Mock - First set initial variables
            const initialVars = { FOO: 'initial' };
            testableInjector.applyEnvVarChanges(mockScopedCollection, initialVars, '/test/workspace');

            replaceStub.resetHistory();

            // Now update
            const updatedVars = { FOO: 'updated' };

            // Run
            testableInjector.applyEnvVarChanges(mockScopedCollection, updatedVars, '/test/workspace');

            // Assert - should replace with new value
            assert.ok(replaceStub.calledWith('FOO', 'updated'), 'Should update FOO to new value');
        });

        test('should delete variables with empty values', () => {
            // Mock - variable set to empty
            const envVars = {
                FOO: 'bar',
                EMPTY: '',
                UNDEFINED: undefined,
            };

            // Run
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, '/test/workspace');

            // Assert - should delete empty/undefined values
            assert.ok(deleteStub.calledWith('EMPTY'), 'Should delete EMPTY');
            assert.ok(deleteStub.calledWith('UNDEFINED'), 'Should delete UNDEFINED');
            assert.ok(replaceStub.calledWith('FOO', 'bar'), 'Should set FOO');
        });

        test('should remove previously tracked vars no longer in .env (commented out scenario)', () => {
            // Mock - First set: FOO, BAR, BAZ
            const initialVars = {
                FOO: 'bar',
                BAR: 'baz',
                BAZ: 'qux',
            };
            testableInjector.applyEnvVarChanges(mockScopedCollection, initialVars, '/test/workspace');

            replaceStub.resetHistory();
            deleteStub.resetHistory();

            // Now update - BAR is commented out (removed)
            const updatedVars = {
                FOO: 'bar',
                BAZ: 'qux',
                // BAR is missing (commented out)
            };

            // Run
            testableInjector.applyEnvVarChanges(mockScopedCollection, updatedVars, '/test/workspace');

            // Assert - should delete BAR
            assert.ok(deleteStub.calledWith('BAR'), 'Should delete commented out variable BAR');
            assert.ok(replaceStub.calledWith('FOO', 'bar'), 'Should keep FOO');
            assert.ok(replaceStub.calledWith('BAZ', 'qux'), 'Should keep BAZ');
        });

        test('should handle first-time initialization with no previous keys', () => {
            // Mock - brand new workspace
            const envVars = {
                NEW_VAR: 'value',
            };

            // Run - apply to workspace that has no tracked vars yet
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, '/new/workspace');

            // Assert - should just add the new variable
            assert.ok(replaceStub.calledWith('NEW_VAR', 'value'), 'Should set NEW_VAR');
            assert.strictEqual(deleteStub.called, false, 'Should not delete anything');
        });

        test('should update tracking map correctly', () => {
            // Mock - set some variables
            const envVars = {
                TRACKED_1: 'value1',
                TRACKED_2: 'value2',
            };

            // Run
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, '/test/workspace');

            // Assert - verify tracking map contains the keys
            const trackedVars = testableInjector.trackedEnvVars.get('/test/workspace');
            assert.ok(trackedVars, 'Should have tracking entry for workspace');
            assert.ok(trackedVars.has('TRACKED_1'), 'Should track TRACKED_1');
            assert.ok(trackedVars.has('TRACKED_2'), 'Should track TRACKED_2');
            assert.strictEqual(trackedVars.size, 2, 'Should track exactly 2 variables');
        });
    });

    suite('cleanupTrackedVars', () => {
        setup(() => {
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        });

        test('should delete all tracked variables', () => {
            // Mock - Set up some tracked variables
            const envVars = {
                VAR1: 'value1',
                VAR2: 'value2',
                VAR3: 'value3',
            };
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, '/test/workspace');

            deleteStub.resetHistory();

            // Run - cleanup
            testableInjector.cleanupTrackedVars(mockScopedCollection, '/test/workspace');

            // Assert - should delete all tracked variables
            assert.strictEqual(deleteStub.callCount, 3, 'Should delete all 3 variables');
            assert.ok(deleteStub.calledWith('VAR1'), 'Should delete VAR1');
            assert.ok(deleteStub.calledWith('VAR2'), 'Should delete VAR2');
            assert.ok(deleteStub.calledWith('VAR3'), 'Should delete VAR3');
        });

        test('should remove workspace from tracking map', () => {
            // Mock - Set up tracked variables
            const envVars = { TEST: 'value' };
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, '/test/workspace');

            // Run - cleanup
            testableInjector.cleanupTrackedVars(mockScopedCollection, '/test/workspace');

            // Assert - tracking should be removed
            const trackedVars = testableInjector.trackedEnvVars.get('/test/workspace');
            assert.strictEqual(trackedVars, undefined, 'Should remove workspace from tracking map');
        });

        test('should handle case when no tracked vars exist (no-op)', () => {
            // Run - cleanup workspace with no tracked vars
            testableInjector.cleanupTrackedVars(mockScopedCollection, '/nonexistent/workspace');

            // Assert - should not throw and not delete anything
            assert.strictEqual(deleteStub.called, false, 'Should not delete anything');
        });
    });

    suite('clearWorkspaceVariables', () => {
        setup(() => {
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
            testableInjector = injector as unknown as TerminalEnvVarInjectorTestable;
        });

        test('should only delete tracked variables', () => {
            // Mock - Set up tracked variables
            const envVars = {
                MY_VAR: 'value',
                ANOTHER_VAR: 'value2',
            };
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, mockWorkspaceFolder.uri.fsPath);

            deleteStub.resetHistory();

            // Run - clear workspace variables
            testableInjector.clearWorkspaceVariables(mockWorkspaceFolder);

            // Assert - should only delete our tracked variables
            assert.strictEqual(deleteStub.callCount, 2, 'Should delete exactly 2 variables');
            assert.ok(deleteStub.calledWith('MY_VAR'), 'Should delete MY_VAR');
            assert.ok(deleteStub.calledWith('ANOTHER_VAR'), 'Should delete ANOTHER_VAR');
        });

        test('should not delete non-tracked variables like BASH_ENV', () => {
            // Mock - Set up only one tracked variable
            const envVars = { MY_VAR: 'value' };
            testableInjector.applyEnvVarChanges(mockScopedCollection, envVars, mockWorkspaceFolder.uri.fsPath);

            // Simulate BASH_ENV being set by another manager (not tracked by us)
            getStub.withArgs('BASH_ENV').returns({ value: 'some_bash_command' });

            deleteStub.resetHistory();

            // Run
            testableInjector.clearWorkspaceVariables(mockWorkspaceFolder);

            // Assert - should only delete MY_VAR, not BASH_ENV
            assert.strictEqual(deleteStub.callCount, 1, 'Should delete only tracked variable');
            assert.ok(deleteStub.calledWith('MY_VAR'), 'Should delete MY_VAR');
            assert.strictEqual(deleteStub.calledWith('BASH_ENV'), false, 'Should not delete BASH_ENV');
        });

        test('should handle errors gracefully', () => {
            // Mock - Make delete throw an error
            deleteStub.throws(new Error('Collection error'));

            // Run - should not throw
            assert.doesNotThrow(() => testableInjector.clearWorkspaceVariables(mockWorkspaceFolder));
        });
    });

    suite('Basic Tests', () => {
        test('should initialize without errors', () => {
            // Arrange & Act
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

            // Assert - should not throw
            sinon.assert.match(injector, sinon.match.object);
        });

        test('should register environment variable change event handler', () => {
            // Arrange - Use the global setup's mock configuration
            // Act
            injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

            // Assert - Verify that the mock's setup was used (handler was registered)
            envVarManager.verify((m) => m.onDidChangeEnvironmentVariables(typeMoq.It.isAny()), typeMoq.Times.once());
        });
    });
});
