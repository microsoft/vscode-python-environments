// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Uri, workspace, GlobalEnvironmentVariableCollection, ConfigurationChangeEvent } from 'vscode';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import * as workspaceApis from '../../common/workspace.apis';

suite('TerminalEnvVarInjector Tests', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;
    let getConfigurationStub: sinon.SinonStub;
    let onDidChangeConfigurationStub: sinon.SinonStub;
    let workspaceFoldersStub: any;

    const testWorkspaceUri = Uri.file('/test/workspace');
    const testWorkspaceUri2 = Uri.file('/test/workspace2');

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        // Mock workspace APIs
        getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration');
        onDidChangeConfigurationStub = sinon.stub(workspaceApis, 'onDidChangeConfiguration');
        
        // Mock workspace.workspaceFolders property
        workspaceFoldersStub = [];
        Object.defineProperty(workspace, 'workspaceFolders', {
            get: () => workspaceFoldersStub,
            configurable: true,
        });

        // Setup default mocks
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns(() => ({
            dispose: () => {},
        }) as any);

        onDidChangeConfigurationStub.returns({
            dispose: () => {},
        });
    });

    teardown(() => {
        sinon.restore();
        injector?.dispose();
    });

    test('should clear and inject environment variables on initialization', async () => {
        // Arrange
        const testEnvVars: { [key: string]: string | undefined } = { TEST_VAR: 'test_value', ANOTHER_VAR: 'another_value' };
        
        workspaceFoldersStub = [{ uri: testWorkspaceUri }];
        
        const mockConfig = {
            get: sinon.stub().returns('.env'),
        };
        getConfigurationStub.returns(mockConfig);
        
        envVarManager
            .setup((m) => m.getEnvironmentVariables(testWorkspaceUri))
            .returns(() => Promise.resolve(testEnvVars));

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        
        // Allow time for async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.once());
        envVarCollection.verify((c) => c.replace('TEST_VAR', 'test_value'), typeMoq.Times.once());
        envVarCollection.verify((c) => c.replace('ANOTHER_VAR', 'another_value'), typeMoq.Times.once());
    });

    test('should not inject variables that match process.env', async () => {
        // Arrange
        const originalProcessEnv = process.env.PATH;
        const testEnvVars: { [key: string]: string | undefined } = { PATH: originalProcessEnv, NEW_VAR: 'new_value' };
        
        workspaceFoldersStub = [{ uri: testWorkspaceUri }];
        
        const mockConfig = {
            get: sinon.stub().returns('.env'),
        };
        getConfigurationStub.returns(mockConfig);
        
        envVarManager
            .setup((m) => m.getEnvironmentVariables(testWorkspaceUri))
            .returns(() => Promise.resolve(testEnvVars));

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        
        // Allow time for async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert
        envVarCollection.verify((c) => c.replace('PATH', typeMoq.It.isAny()), typeMoq.Times.never());
        envVarCollection.verify((c) => c.replace('NEW_VAR', 'new_value'), typeMoq.Times.once());
    });

    test('should handle multiple workspace folders', async () => {
        // Arrange
        const testEnvVars1: { [key: string]: string | undefined } = { WORKSPACE1_VAR: 'value1' };
        const testEnvVars2: { [key: string]: string | undefined } = { WORKSPACE2_VAR: 'value2' };
        
        workspaceFoldersStub = [
            { uri: testWorkspaceUri },
            { uri: testWorkspaceUri2 },
        ];
        
        const mockConfig = {
            get: sinon.stub().returns('.env'),
        };
        getConfigurationStub.returns(mockConfig);
        
        envVarManager
            .setup((m) => m.getEnvironmentVariables(testWorkspaceUri))
            .returns(() => Promise.resolve(testEnvVars1));
        envVarManager
            .setup((m) => m.getEnvironmentVariables(testWorkspaceUri2))
            .returns(() => Promise.resolve(testEnvVars2));

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        
        // Allow time for async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert
        envVarCollection.verify((c) => c.replace('WORKSPACE1_VAR', 'value1'), typeMoq.Times.once());
        envVarCollection.verify((c) => c.replace('WORKSPACE2_VAR', 'value2'), typeMoq.Times.once());
    });

    test('should handle no workspace folders gracefully', async () => {
        // Arrange
        workspaceFoldersStub = undefined;

        // Act
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        
        // Allow time for async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.once());
        envVarManager.verify((m) => m.getEnvironmentVariables(typeMoq.It.isAny()), typeMoq.Times.never());
    });

    test('should respond to configuration changes', async () => {
        // Arrange
        let configChangeCallback: (e: ConfigurationChangeEvent) => void;
        onDidChangeConfigurationStub.callsFake((callback) => {
            configChangeCallback = callback;
            return { dispose: () => {} };
        });

        const testEnvVars: { [key: string]: string | undefined } = { CONFIG_CHANGED_VAR: 'changed_value' };
        workspaceFoldersStub = [{ uri: testWorkspaceUri }];
        
        const mockConfig = {
            get: sinon.stub().returns('.env'),
        };
        getConfigurationStub.returns(mockConfig);
        
        envVarManager
            .setup((m) => m.getEnvironmentVariables(testWorkspaceUri))
            .returns(() => Promise.resolve(testEnvVars));

        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        
        // Allow time for async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Reset the mock to count only new calls
        envVarCollection.reset();

        // Act - simulate configuration change
        const mockConfigEvent = {
            affectsConfiguration: sinon.stub().withArgs('python.envFile').returns(true),
        } as any;
        
        configChangeCallback!(mockConfigEvent);
        
        // Allow time for async update
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.once());
        envVarCollection.verify((c) => c.replace('CONFIG_CHANGED_VAR', 'changed_value'), typeMoq.Times.once());
    });

    test('should handle errors gracefully during environment variable retrieval', async () => {
        // Arrange
        workspaceFoldersStub = [{ uri: testWorkspaceUri }];
        
        envVarManager
            .setup((m) => m.getEnvironmentVariables(testWorkspaceUri))
            .returns(() => Promise.reject(new Error('Test error')));

        // Act & Assert - should not throw
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);
        
        // Allow time for async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Should still clear the collection even if error occurs
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.once());
    });

    test('should clear environment variables on dispose', () => {
        // Arrange
        workspaceFoldersStub = [];
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Act
        injector.dispose();

        // Assert
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.atLeastOnce());
    });
});