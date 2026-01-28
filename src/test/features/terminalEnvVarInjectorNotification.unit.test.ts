// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { GlobalEnvironmentVariableCollection, Uri, workspace } from 'vscode';
import * as commandApi from '../../common/command.api';
import { Common } from '../../common/localize';
import * as persistentState from '../../common/persistentState';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';

interface MockScopedCollection {
    clear: sinon.SinonStub;
    replace: sinon.SinonStub;
    delete: sinon.SinonStub;
}

suite('TerminalEnvVarInjector Notification Tests', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;
    let mockScopedCollection: MockScopedCollection;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let mockGetConfiguration: sinon.SinonStub;
    let mockGetWorkspaceFolder: sinon.SinonStub;
    let mockShowInformationMessage: sinon.SinonStub;
    let mockExecuteCommand: sinon.SinonStub;
    let envVarChangeHandler: (args: { uri?: Uri; changeType?: number }) => void;
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

        // Setup persistent state mocks
        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        // Setup workspace API mocks
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        mockGetWorkspaceFolder = sinon.stub(workspaceApis, 'getWorkspaceFolder');

        // Setup showInformationMessage mock
        mockShowInformationMessage = sinon.stub(windowApis, 'showInformationMessage').resolves(undefined);

        // Setup executeCommand mock
        mockExecuteCommand = sinon.stub(commandApi, 'executeCommand').resolves();

        // Setup environment variable change event handler - will be overridden in tests
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns(
                () =>
                    ({
                        dispose: () => {},
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as any),
            );
    });

    teardown(() => {
        sinon.restore();
        injector?.dispose();
    });

    test('should show notification when env file exists and useEnvFile is false (first time)', async () => {
        // Arrange - user has not dismissed the notification before
        mockState.get.resolves(false);

        // Setup environment variable change handler to capture it
        envVarManager.reset();
        envVarCollection.reset();

        // Re-setup scoped collection after reset
        envVarCollection
            .setup((x) => x.getScoped(typeMoq.It.isAny()))
            .returns(
                () => mockScopedCollection as unknown as ReturnType<GlobalEnvironmentVariableCollection['getScoped']>,
            );
        envVarCollection.setup((x) => x.clear()).returns(() => {});

        // Setup event handler to capture it
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((handler) => {
                envVarChangeHandler = handler;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns('.env');
        mockGetConfiguration.returns(mockConfig);

        const testUri = Uri.file('/workspace');
        mockGetWorkspaceFolder.returns({ uri: testUri });

        // Act - create injector and trigger env var change
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async initialization

        envVarChangeHandler({ uri: testUri });
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async notification

        // Assert - notification should be shown with both buttons
        assert.ok(mockShowInformationMessage.called, 'showInformationMessage should be called');
        const notificationCall = mockShowInformationMessage.getCall(0);
        assert.ok(
            notificationCall.args[0].includes('environment file is configured'),
            'Notification should mention environment file',
        );
        assert.strictEqual(
            notificationCall.args[1],
            Common.openSettings,
            'Notification should have "Open Settings" button',
        );
        assert.strictEqual(
            notificationCall.args[2],
            Common.dontShowAgain,
            'Notification should have "Don\'t Show Again" button',
        );
    });

    test('should not show notification when user has clicked "Don\'t Show Again"', async () => {
        // Arrange - user has previously dismissed the notification
        mockState.get.resolves(true);

        // Setup environment variable change handler to capture it
        envVarManager.reset();
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((handler) => {
                envVarChangeHandler = handler;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns('.env');
        mockGetConfiguration.returns(mockConfig);

        const testUri = Uri.file('/workspace');
        mockGetWorkspaceFolder.returns({ uri: testUri });

        // Act - create injector and trigger env var change
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async initialization

        envVarChangeHandler({ uri: testUri });
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async notification

        // Assert - notification should NOT be shown
        assert.ok(!mockShowInformationMessage.called, 'showInformationMessage should not be called');
    });

    test('should store preference when user clicks "Don\'t Show Again"', async () => {
        // Arrange - user clicks the "Don't Show Again" button
        mockState.get.resolves(false);
        mockShowInformationMessage.resolves(Common.dontShowAgain);

        // Setup environment variable change handler to capture it
        envVarManager.reset();
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((handler) => {
                envVarChangeHandler = handler;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns('.env');
        mockGetConfiguration.returns(mockConfig);

        const testUri = Uri.file('/workspace');
        mockGetWorkspaceFolder.returns({ uri: testUri });

        // Act - create injector and trigger env var change
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async initialization

        envVarChangeHandler({ uri: testUri });
        await new Promise((resolve) => setTimeout(resolve, 50)); // Allow async notification and state update

        // Assert - state should be set to true
        assert.ok(mockState.set.called, 'state.set should be called');
        const setCall = mockState.set.getCall(0);
        assert.strictEqual(setCall.args[0], 'dontShowEnvFileNotification', 'Should use correct state key');
        assert.strictEqual(setCall.args[1], true, 'Should set state to true');
    });

    test('should open settings when user clicks "Open Settings" button', async () => {
        // Arrange - user clicks the "Open Settings" button
        mockState.get.resolves(false);
        mockShowInformationMessage.resolves(Common.openSettings);

        // Setup environment variable change handler to capture it
        envVarManager.reset();
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((handler) => {
                envVarChangeHandler = handler;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns('.env');
        mockGetConfiguration.returns(mockConfig);

        const testUri = Uri.file('/workspace');
        mockGetWorkspaceFolder.returns({ uri: testUri });

        // Act - create injector and trigger env var change
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async initialization

        envVarChangeHandler({ uri: testUri });
        await new Promise((resolve) => setTimeout(resolve, 50)); // Allow async notification and command execution

        // Assert - executeCommand should be called to open settings
        assert.ok(mockExecuteCommand.called, 'executeCommand should be called');
        const commandCall = mockExecuteCommand.getCall(0);
        assert.strictEqual(commandCall.args[0], 'workbench.action.openSettings', 'Should open settings');
        assert.strictEqual(commandCall.args[1], 'python.terminal.useEnvFile', 'Should open useEnvFile setting');
        // State should NOT be set when clicking "Open Settings"
        assert.ok(!mockState.set.called, 'state.set should not be called when opening settings');
    });

    test('should not show notification when useEnvFile is true', async () => {
        // Arrange - useEnvFile is enabled
        mockState.get.resolves(false);

        // Setup environment variable change handler to capture it
        envVarManager.reset();
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((handler) => {
                envVarChangeHandler = handler;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(true); // enabled
        mockConfig.get.withArgs('envFile').returns('.env');
        mockGetConfiguration.returns(mockConfig);

        const testUri = Uri.file('/workspace');
        mockGetWorkspaceFolder.returns({ uri: testUri });

        // Act - create injector and trigger env var change
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async initialization

        envVarChangeHandler({ uri: testUri });
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async notification

        // Assert - notification should NOT be shown
        assert.ok(!mockShowInformationMessage.called, 'showInformationMessage should not be called');
    });

    test('should not show notification when envFile is not configured', async () => {
        // Arrange - no envFile configured
        mockState.get.resolves(false);

        // Setup environment variable change handler to capture it
        envVarManager.reset();
        envVarManager
            .setup((m) => m.onDidChangeEnvironmentVariables)
            .returns((handler) => {
                envVarChangeHandler = handler;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return { dispose: () => {} } as any;
            });

        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);
        mockConfig.get.withArgs('envFile').returns(undefined); // no env file
        mockGetConfiguration.returns(mockConfig);

        const testUri = Uri.file('/workspace');
        mockGetWorkspaceFolder.returns({ uri: testUri });

        // Act - create injector and trigger env var change
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async initialization

        envVarChangeHandler({ uri: testUri });
        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async notification

        // Assert - notification should NOT be shown
        assert.ok(!mockShowInformationMessage.called, 'showInformationMessage should not be called');
    });
});
