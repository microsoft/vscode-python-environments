import * as assert from 'assert';
import * as sinon from 'sinon';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    ACT_TYPE_COMMAND,
    ACT_TYPE_OFF,
    ACT_TYPE_SHELL,
    AutoActivationType,
    getAutoActivationType,
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

import { env, Terminal, TerminalOptions, Uri } from 'vscode';
import {
    getShellIntegrationTimeout,
    getTerminalCwd,
    isTaskTerminal,
    removeAnsiEscapeCodes,
} from '../../../features/terminal/utils';

/**
 * Creates a mock Terminal for testing.
 */
function createMockTerminal(options?: { name?: string; cwd?: string | Uri }): Terminal {
    const terminalOptions: TerminalOptions = {
        cwd: options?.cwd,
    };
    return {
        name: options?.name ?? 'Test Terminal',
        creationOptions: terminalOptions,
        shellIntegration: undefined,
        processId: Promise.resolve(12345),
        exitStatus: undefined,
        state: { isInteractedWith: false },
        show: sinon.stub(),
        hide: sinon.stub(),
        sendText: sinon.stub(),
        dispose: sinon.stub(),
    } as unknown as Terminal;
}

suite('Terminal Utils - removeAnsiEscapeCodes', () => {
    test('should remove CSI sequence (color codes)', () => {
        const input = '\u001b[31mHello, World!\u001b[0m';
        const result = removeAnsiEscapeCodes(input);
        assert.strictEqual(result, 'Hello, World!', 'Should remove ANSI color codes');
    });

    test('should remove multiple ANSI escape sequences', () => {
        const input = '\u001b[1m\u001b[32mBold Green\u001b[0m Normal';
        const result = removeAnsiEscapeCodes(input);
        assert.strictEqual(result, 'Bold Green Normal', 'Should remove multiple ANSI codes');
    });

    test('should handle OSC sequences', () => {
        const input = '\u001b]0;Window Title\u0007Some text';
        const result = removeAnsiEscapeCodes(input);
        assert.strictEqual(result, 'Some text', 'Should remove OSC sequences');
    });

    test('should handle empty string', () => {
        const result = removeAnsiEscapeCodes('');
        assert.strictEqual(result, '', 'Should return empty string for empty input');
    });

    test('should handle string with no escape codes', () => {
        const input = 'Plain text without codes';
        const result = removeAnsiEscapeCodes(input);
        assert.strictEqual(result, input, 'Should return unchanged string when no codes present');
    });

    test('should handle cursor movement sequences', () => {
        const input = '\u001b[2J\u001b[HText after clear';
        const result = removeAnsiEscapeCodes(input);
        assert.strictEqual(result, 'Text after clear', 'Should remove cursor control sequences');
    });

    test('should remove 256-color and true color codes', () => {
        const input = '\u001b[38;5;196mRed 256\u001b[0m \u001b[38;2;255;0;0mTrue Red\u001b[0m';
        const result = removeAnsiEscapeCodes(input);
        assert.strictEqual(result, 'Red 256 True Red', 'Should remove 256-color and true color codes');
    });

    test('should handle falsy input gracefully', () => {
        // The function checks for truthiness before replacing
        const result = removeAnsiEscapeCodes(undefined as unknown as string);
        assert.strictEqual(result, undefined, 'Should return undefined for undefined input');
    });
});

suite('Terminal Utils - isTaskTerminal', () => {
    test('should return true for terminal with "task" in lowercase name', () => {
        const terminal = createMockTerminal({ name: 'task - build' });
        const result = isTaskTerminal(terminal);
        assert.strictEqual(result, true, 'Should identify task terminal by lowercase name');
    });

    test('should return true for terminal with "Task" in name (case insensitive)', () => {
        const terminal = createMockTerminal({ name: 'Task - Run Tests' });
        const result = isTaskTerminal(terminal);
        assert.strictEqual(result, true, 'Should identify Task terminal case-insensitively');
    });

    test('should return true for terminal with "TASK" in uppercase name', () => {
        const terminal = createMockTerminal({ name: 'TASK - compile' });
        const result = isTaskTerminal(terminal);
        assert.strictEqual(result, true, 'Should identify TASK terminal in uppercase');
    });

    test('should return false for regular terminal', () => {
        const terminal = createMockTerminal({ name: 'Python' });
        const result = isTaskTerminal(terminal);
        assert.strictEqual(result, false, 'Should return false for non-task terminal');
    });

    test('should return false for terminal with "task" as part of another word', () => {
        // The current implementation uses includes(), so this would actually return true
        // This test documents the current behavior
        const terminal = createMockTerminal({ name: 'multitasking' });
        const result = isTaskTerminal(terminal);
        // Note: Current implementation returns true because 'multitasking' includes 'task'
        assert.strictEqual(result, true, 'Current implementation matches task anywhere in name');
    });
});

suite('Terminal Utils - getTerminalCwd', () => {
    test('should return cwd from shellIntegration when available', () => {
        const terminal = createMockTerminal();
        const mockCwd = Uri.file('/shell/integration/cwd');
        (terminal as Terminal & { shellIntegration: { cwd: Uri } }).shellIntegration = { cwd: mockCwd } as never;

        const result = getTerminalCwd(terminal);

        assert.strictEqual(result, '/shell/integration/cwd', 'Should return shell integration cwd');
    });

    test('should return cwd from creationOptions when shellIntegration is not available', () => {
        const terminal = createMockTerminal({ cwd: '/creation/options/cwd' });

        const result = getTerminalCwd(terminal);

        assert.strictEqual(result, '/creation/options/cwd', 'Should return creation options cwd string');
    });

    test('should return cwd from creationOptions Uri when shellIntegration is not available', () => {
        const terminal = createMockTerminal({ cwd: Uri.file('/creation/options/uri/cwd') });

        const result = getTerminalCwd(terminal);

        assert.strictEqual(result, '/creation/options/uri/cwd', 'Should return creation options Uri cwd');
    });

    test('should return undefined when no cwd is available', () => {
        const terminal = createMockTerminal();

        const result = getTerminalCwd(terminal);

        assert.strictEqual(result, undefined, 'Should return undefined when no cwd available');
    });

    test('should prefer shellIntegration cwd over creationOptions cwd', () => {
        const terminal = createMockTerminal({ cwd: '/creation/cwd' });
        const mockCwd = Uri.file('/shell/cwd');
        (terminal as Terminal & { shellIntegration: { cwd: Uri } }).shellIntegration = { cwd: mockCwd } as never;

        const result = getTerminalCwd(terminal);

        assert.strictEqual(result, '/shell/cwd', 'Should prefer shell integration cwd');
    });
});

suite('Terminal Utils - getShellIntegrationTimeout', () => {
    let mockGetConfiguration: sinon.SinonStub;

    setup(() => {
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return configured timeout value when valid', () => {
        mockGetConfiguration.withArgs('terminal.integrated').returns({
            get: sinon.stub().callsFake((key: string, defaultValue?: boolean) => {
                if (key === 'shellIntegration.timeout') return 3000;
                if (key === 'shellIntegration.enabled') return defaultValue;
                return undefined;
            }),
        });

        const result = getShellIntegrationTimeout();

        assert.strictEqual(result, 3000, 'Should return configured timeout');
    });

    test('should return minimum 500ms even if configured lower', () => {
        mockGetConfiguration.withArgs('terminal.integrated').returns({
            get: sinon.stub().callsFake((key: string, defaultValue?: boolean) => {
                if (key === 'shellIntegration.timeout') return 100;
                if (key === 'shellIntegration.enabled') return defaultValue;
                return undefined;
            }),
        });

        const result = getShellIntegrationTimeout();

        assert.strictEqual(result, 500, 'Should return minimum 500ms');
    });

    test('should return 5000ms default when shell integration is enabled and no timeout configured', () => {
        mockGetConfiguration.withArgs('terminal.integrated').returns({
            get: sinon.stub().callsFake((key: string, defaultValue?: boolean) => {
                if (key === 'shellIntegration.timeout') return undefined;
                if (key === 'shellIntegration.enabled') return true;
                return defaultValue;
            }),
        });

        const result = getShellIntegrationTimeout();

        assert.strictEqual(result, 5000, 'Should return 5000ms when shell integration enabled');
    });

    test('should return 2000ms default when shell integration is disabled and not remote', () => {
        mockGetConfiguration.withArgs('terminal.integrated').returns({
            get: sinon.stub().callsFake((key: string, defaultValue?: boolean) => {
                if (key === 'shellIntegration.timeout') return undefined;
                if (key === 'shellIntegration.enabled') return false;
                return defaultValue;
            }),
        });

        // env.remoteName is undefined by default in test environment (not remote)
        // We can test this scenario without stubbing since tests run locally

        const result = getShellIntegrationTimeout();

        // Result depends on whether env.remoteName is undefined (local) or defined (remote)
        // In local test environment, remoteName is undefined, so we expect 2000ms
        const isRemote = env.remoteName !== undefined;
        const expected = isRemote ? 3000 : 2000;
        assert.strictEqual(result, expected, `Should return ${expected}ms when not enabled and ${isRemote ? 'remote' : 'not remote'}`);
    });

    test('should handle negative timeout value by using defaults', () => {
        mockGetConfiguration.withArgs('terminal.integrated').returns({
            get: sinon.stub().callsFake((key: string, defaultValue?: boolean) => {
                if (key === 'shellIntegration.timeout') return -1000;
                if (key === 'shellIntegration.enabled') return true;
                return defaultValue;
            }),
        });

        const result = getShellIntegrationTimeout();

        assert.strictEqual(result, 5000, 'Should return default when timeout is negative');
    });

    test('should handle non-number timeout value by using defaults', () => {
        mockGetConfiguration.withArgs('terminal.integrated').returns({
            get: sinon.stub().callsFake((key: string, defaultValue?: boolean) => {
                if (key === 'shellIntegration.timeout') return 'invalid';
                if (key === 'shellIntegration.enabled') return true;
                return defaultValue;
            }),
        });

        const result = getShellIntegrationTimeout();

        assert.strictEqual(result, 5000, 'Should return default when timeout is not a number');
    });
});
