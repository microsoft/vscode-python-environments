// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { GlobalEnvironmentVariableCollection, ConfigurationChangeEvent } from 'vscode';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import * as workspaceApis from '../../common/workspace.apis';

suite('TerminalEnvVarInjector Basic Tests', () => {
    let envVarCollection: typeMoq.IMock<GlobalEnvironmentVariableCollection>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let injector: TerminalEnvVarInjector;

    setup(() => {
        envVarCollection = typeMoq.Mock.ofType<GlobalEnvironmentVariableCollection>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        // Setup minimal mocks for event subscriptions
        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns(() => ({
            dispose: () => {},
        }) as any);

        sinon.stub(workspaceApis, 'onDidChangeConfiguration').returns({
            dispose: () => {},
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
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.once());
    });

    test('should dispose cleanly', () => {
        // Arrange
        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Act
        injector.dispose();

        // Assert - should clear on dispose
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.atLeastOnce());
    });

    test('should handle configuration changes', () => {
        // Arrange
        let configChangeCallback: (e: ConfigurationChangeEvent) => void;
        sinon.restore();
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((callback) => {
            configChangeCallback = callback;
            return { dispose: () => {} };
        });

        envVarManager.setup((m) => m.onDidChangeEnvironmentVariables).returns(() => ({
            dispose: () => {},
        }) as any);

        injector = new TerminalEnvVarInjector(envVarCollection.object, envVarManager.object);

        // Act - simulate configuration change
        const mockConfigEvent = {
            affectsConfiguration: sinon.stub().withArgs('python.envFile').returns(true),
        } as any;

        configChangeCallback!(mockConfigEvent);

        // Assert - should clear collection when config changes
        envVarCollection.verify((c) => c.clear(), typeMoq.Times.atLeastOnce());
    });
});