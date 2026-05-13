import * as assert from 'assert';
import * as sinon from 'sinon';
import { Terminal } from 'vscode';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import * as shellDetector from '../../../features/common/shellDetector';
import {
    ACT_TYPE_COMMAND,
    ACT_TYPE_OFF,
    ACT_TYPE_SHELL,
    AutoActivationType,
    getAutoActivationType,
    shouldActivateInCurrentTerminal,
    waitForShellIntegration,
} from '../../../features/terminal/utils';

interface MockWorkspaceConfig {
    get: sinon.SinonStub;
    inspect: sinon.SinonStub;
    update: sinon.SinonStub;
}

suite('Terminal Utils - getAutoActivationType', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let pyEnvsConfig: MockWorkspaceConfig;
    let pythonConfig: MockWorkspaceConfig;

    setup(() => {
        // Initialize mocks
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');

        // Create mock configuration objects
        pyEnvsConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        pythonConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        // Set up default configuration returns
        mockGetConfiguration.withArgs('python-envs').returns(pyEnvsConfig);
        mockGetConfiguration.withArgs('python').returns(pythonConfig);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('Priority Order Tests', () => {
        test('should return globalRemoteValue when set (highest priority)', () => {
            // Mock - globalRemoteValue is set
            const mockInspectResult = {
                globalRemoteValue: ACT_TYPE_SHELL,
                globalLocalValue: ACT_TYPE_COMMAND,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_SHELL, 'Should return globalRemoteValue when set');
        });

        test('should return globalLocalValue when globalRemoteValue is undefined', () => {
            // Mock - globalRemoteValue is undefined, globalLocalValue is set
            const mockInspectResult = {
                globalRemoteValue: undefined,
                globalLocalValue: ACT_TYPE_SHELL,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_SHELL,
                'Should return globalLocalValue when globalRemoteValue is undefined',
            );
        });

        test('should return globalValue when both globalRemoteValue and globalLocalValue are undefined', () => {
            // Mock - only globalValue is set
            const mockInspectResult = {
                globalRemoteValue: undefined,
                globalLocalValue: undefined,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_OFF,
                'Should return globalValue when higher priority values are undefined',
            );
        });

        test('should ignore globalLocalValue and globalValue when globalRemoteValue exists', () => {
            // Mock - all values set, should prioritize globalRemoteValue
            const mockInspectResult = {
                globalRemoteValue: ACT_TYPE_OFF,
                globalLocalValue: ACT_TYPE_SHELL,
                globalValue: ACT_TYPE_COMMAND,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_OFF, 'Should prioritize globalRemoteValue over other values');
        });

        test('should ignore globalValue when globalLocalValue exists', () => {
            // Mock - globalLocalValue and globalValue set, should prioritize globalLocalValue
            const mockInspectResult = {
                globalLocalValue: ACT_TYPE_SHELL,
                globalValue: ACT_TYPE_COMMAND,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_SHELL, 'Should prioritize globalLocalValue over globalValue');
        });
    });

    suite('Custom Properties Handling', () => {
        test('should handle case when globalRemoteValue property does not exist', () => {
            // Mock - standard VS Code inspection result without custom properties
            const mockInspectResult = {
                key: 'terminal.autoActivationType',
                globalValue: ACT_TYPE_SHELL,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_SHELL, 'Should return globalValue when custom properties do not exist');
        });

        test('should handle case when globalLocalValue property does not exist', () => {
            // Mock - inspection result without globalLocalValue property
            const mockInspectResult = {
                key: 'terminal.autoActivationType',
                globalValue: ACT_TYPE_COMMAND,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_COMMAND,
                'Should return globalValue when globalLocalValue property does not exist',
            );
        });

        test('should handle case when custom properties exist but are undefined', () => {
            // Mock - custom properties exist but have undefined values
            const mockInspectResult = {
                globalRemoteValue: undefined,
                globalLocalValue: undefined,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_OFF,
                'Should fall back to globalValue when custom properties are undefined',
            );
        });
    });

    suite('Legacy Python Setting Fallback', () => {
        test('should return ACT_TYPE_OFF and update config when python.terminal.activateEnvironment is false', () => {
            // Mock - no python-envs settings, python.terminal.activateEnvironment is false
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(false);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_OFF, 'Should return ACT_TYPE_OFF when legacy setting is false');
            assert.ok(
                pyEnvsConfig.update.calledWithExactly('terminal.autoActivationType', ACT_TYPE_OFF),
                'Should update python-envs config to ACT_TYPE_OFF',
            );
        });

        test('should return ACT_TYPE_COMMAND when python.terminal.activateEnvironment is true', () => {
            // Mock - no python-envs settings, python.terminal.activateEnvironment is true
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(true);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should return ACT_TYPE_COMMAND when legacy setting is true');
            assert.ok(
                pyEnvsConfig.update.notCalled,
                'Should not update python-envs config when legacy setting is true',
            );
        });

        test('should return ACT_TYPE_COMMAND when python.terminal.activateEnvironment is undefined', () => {
            // Mock - no python-envs settings, python.terminal.activateEnvironment is undefined
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should return ACT_TYPE_COMMAND when no settings are found');
            assert.ok(
                pyEnvsConfig.update.notCalled,
                'Should not update python-envs config when no legacy setting exists',
            );
        });
    });

    suite('Fallback Scenarios', () => {
        test('should return ACT_TYPE_COMMAND when no configuration exists', () => {
            // Mock - no configurations exist
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_COMMAND,
                'Should return default ACT_TYPE_COMMAND when no configurations exist',
            );
        });

        test('should return ACT_TYPE_COMMAND when python-envs config exists but all values are undefined', () => {
            // Mock - python-envs config exists but all relevant values are undefined
            const mockInspectResult = {
                key: 'terminal.autoActivationType',
                globalValue: undefined,
                workspaceValue: undefined,
                workspaceFolderValue: undefined,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_COMMAND,
                'Should return default when python-envs config exists but values are undefined',
            );
        });

        test('should prioritize python-envs settings over legacy python settings', () => {
            // Mock - python-envs has globalValue, python has conflicting setting
            const mockInspectResult = {
                globalValue: ACT_TYPE_SHELL,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(false);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_SHELL,
                'Should prioritize python-envs globalValue over legacy python setting',
            );
            assert.ok(
                pyEnvsConfig.update.notCalled,
                'Should not update python-envs config when it already has a value',
            );
        });
    });

    suite('Edge Cases', () => {
        test('should handle null inspect result', () => {
            // Mock - inspect returns null
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(null);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should handle null inspect result gracefully');
        });

        test('should handle empty object inspect result', () => {
            // Mock - inspect returns empty object
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns({});
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should handle empty inspect result gracefully');
        });

        test('should handle all AutoActivationType values correctly', () => {
            const testCases: { input: AutoActivationType; expected: AutoActivationType }[] = [
                { input: ACT_TYPE_COMMAND, expected: ACT_TYPE_COMMAND },
                { input: ACT_TYPE_SHELL, expected: ACT_TYPE_SHELL },
                { input: ACT_TYPE_OFF, expected: ACT_TYPE_OFF },
            ];

            testCases.forEach(({ input, expected }) => {
                // Reset stubs for each test case
                pyEnvsConfig.inspect.resetHistory();
                pythonConfig.get.resetHistory();

                // Mock - set globalValue to test input
                const mockInspectResult = { globalValue: input };
                pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

                // Run
                const result = getAutoActivationType();

                // Assert
                assert.strictEqual(result, expected, `Should handle ${input} value correctly`);
            });
        });
    });
});

suite('Terminal Utils - shouldActivateInCurrentTerminal', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let pythonConfig: MockWorkspaceConfig;

    setup(() => {
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');

        pythonConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        mockGetConfiguration.withArgs('python').returns(pythonConfig);
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return true when inspect returns undefined (no config)', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns(undefined);

        assert.strictEqual(shouldActivateInCurrentTerminal(), true, 'Should default to true when no config exists');
    });

    test('should return true when no explicit values are set (all undefined)', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            true,
            'Should return true when only defaultValue is set (not user-explicit)',
        );
    });

    test('should return false when globalValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: false,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set globalValue to false',
        );
    });

    test('should return false when workspaceValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: undefined,
            workspaceValue: false,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set workspaceValue to false',
        );
    });

    test('should return false when workspaceFolderValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: false,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set workspaceFolderValue to false',
        );
    });

    test('should return true when globalValue is explicitly true', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: true,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            true,
            'Should return true when user explicitly set globalValue to true',
        );
    });

    test('workspaceFolderValue false takes precedence over globalValue true', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: true,
            workspaceValue: undefined,
            workspaceFolderValue: false,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'workspaceFolderValue false should take precedence',
        );
    });

    test('should return false when globalRemoteValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalRemoteValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set globalRemoteValue to false',
        );
    });

    test('should return false when globalLocalValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalLocalValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set globalLocalValue to false',
        );
    });

    test('workspaceValue false takes precedence over globalRemoteValue true', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalRemoteValue: true,
            globalValue: undefined,
            workspaceValue: false,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'workspaceValue false should take precedence over globalRemoteValue true',
        );
    });

    test('should return false when globalValue is false even if workspaceValue is true (any explicit false wins)', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: false,
            workspaceValue: true,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Any explicit false at any scope should return false, regardless of higher-precedence true values',
        );
    });
});

suite('Terminal Utils - waitForShellIntegration', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let identifyTerminalShellStub: sinon.SinonStub;
    let onDidChangeTerminalShellIntegrationStub: sinon.SinonStub;
    let onDidWriteTerminalDataStub: sinon.SinonStub;

    function setupLongTimeoutConfig() {
        // Make the timeout effectively infinite so tests resolve via the listener,
        // not the timer. Avoids flakiness while keeping the race code paths exercised.
        const config = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };
        config.get.withArgs('shellIntegration.timeout').returns(60_000);
        config.get.withArgs('shellIntegration.enabled', true).returns(true);
        mockGetConfiguration.withArgs('terminal.integrated').returns(config);
    }

    setup(() => {
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        identifyTerminalShellStub = sinon.stub(shellDetector, 'identifyTerminalShell');
        onDidChangeTerminalShellIntegrationStub = sinon.stub(windowApis, 'onDidChangeTerminalShellIntegration');
        onDidWriteTerminalDataStub = sinon.stub(windowApis, 'onDidWriteTerminalData');

        // Default: dispose-only fake event registrations. Tests that need to fire
        // events override these via .callsFake.
        const fakeDisposable = { dispose: () => undefined };
        onDidChangeTerminalShellIntegrationStub.returns(fakeDisposable);
        onDidWriteTerminalDataStub.returns(fakeDisposable);
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns false immediately when terminal is undefined', async () => {
        const result = await waitForShellIntegration(undefined);

        assert.strictEqual(result, false);
        sinon.assert.notCalled(identifyTerminalShellStub);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
    });

    test('returns true immediately when terminal.shellIntegration is already set', async () => {
        const terminal = { shellIntegration: {} } as unknown as Terminal;

        const result = await waitForShellIntegration(terminal);

        assert.strictEqual(result, true);
        sinon.assert.notCalled(identifyTerminalShellStub);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
    });

    test('returns false immediately for nu without registering event listeners', async () => {
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('nu');

        const result = await waitForShellIntegration(terminal);

        assert.strictEqual(result, false);
        sinon.assert.calledOnce(identifyTerminalShellStub);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
        sinon.assert.notCalled(onDidWriteTerminalDataStub);
    });

    test('returns false immediately for cmd', async () => {
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('cmd');

        const result = await waitForShellIntegration(terminal);

        assert.strictEqual(result, false);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
    });

    test('returns false immediately for csh / tcsh / ksh / xonsh', async () => {
        const unsupported = ['csh', 'tcsh', 'ksh', 'xonsh'];
        for (const shell of unsupported) {
            identifyTerminalShellStub.resetHistory();
            identifyTerminalShellStub.returns(shell);
            onDidChangeTerminalShellIntegrationStub.resetHistory();

            const result = await waitForShellIntegration({} as Terminal);

            assert.strictEqual(result, false, `expected false for shell '${shell}'`);
            sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
        }
    });

    test('falls through to event race for bash (supported shell)', async () => {
        setupLongTimeoutConfig();
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('bash');

        let listenerRef: ((e: { terminal: Terminal }) => void) | undefined;
        onDidChangeTerminalShellIntegrationStub.callsFake((listener: (e: { terminal: Terminal }) => void) => {
            listenerRef = listener;
            return { dispose: () => undefined };
        });

        const racePromise = waitForShellIntegration(terminal);
        // Yield once so the Promise.race body has a chance to register listeners.
        await new Promise<void>((r) => setImmediate(r));
        assert.ok(listenerRef, 'shell integration listener should be registered');
        listenerRef!({ terminal });

        const result = await racePromise;
        assert.strictEqual(result, true);
        sinon.assert.calledOnce(onDidChangeTerminalShellIntegrationStub);
    });

    test('falls through to event race when shell type is unknown', async () => {
        setupLongTimeoutConfig();
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('unknown');

        let listenerRef: ((e: { terminal: Terminal }) => void) | undefined;
        onDidChangeTerminalShellIntegrationStub.callsFake((listener: (e: { terminal: Terminal }) => void) => {
            listenerRef = listener;
            return { dispose: () => undefined };
        });

        const racePromise = waitForShellIntegration(terminal);
        await new Promise<void>((r) => setImmediate(r));
        listenerRef!({ terminal });

        const result = await racePromise;
        assert.strictEqual(result, true);
    });

    test('falls through to event race when identifyTerminalShell throws', async () => {
        setupLongTimeoutConfig();
        const terminal = {} as Terminal;
        identifyTerminalShellStub.throws(new Error('detection failed'));

        let listenerRef: ((e: { terminal: Terminal }) => void) | undefined;
        onDidChangeTerminalShellIntegrationStub.callsFake((listener: (e: { terminal: Terminal }) => void) => {
            listenerRef = listener;
            return { dispose: () => undefined };
        });

        const racePromise = waitForShellIntegration(terminal);
        await new Promise<void>((r) => setImmediate(r));
        listenerRef!({ terminal });

        const result = await racePromise;
        assert.strictEqual(result, true, 'should not regress when detection throws');
    });
});
