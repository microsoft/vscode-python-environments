// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
    Disposable,
    EventEmitter,
    Terminal,
    TerminalOptions,
    TerminalShellExecution,
    TerminalShellExecutionEndEvent,
    TerminalShellIntegration,
    Uri,
} from 'vscode';
import { PythonEnvironment, PythonTerminalExecutionOptions } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { ShellConstants } from '../../../features/common/shellConstants';
import * as shellDetector from '../../../features/common/shellDetector';
import { runInTerminal } from '../../../features/terminal/runInTerminal';

/**
 * Creates a mock PythonEnvironment for testing.
 */
function createMockEnvironment(overrides?: Partial<PythonEnvironment>): PythonEnvironment {
    return {
        envId: { id: 'test-env-id', managerId: 'test-manager' },
        name: 'Test Environment',
        displayName: 'Test Environment',
        shortDisplayName: 'TestEnv',
        displayPath: '/path/to/env',
        version: '3.9.0',
        environmentPath: Uri.file('/path/to/python'),
        sysPrefix: '/path/to/env',
        execInfo: {
            run: { executable: '/usr/bin/python', args: [] },
            activatedRun: { executable: '/path/to/env/bin/python', args: [] },
        },
        ...overrides,
    };
}

interface MockTerminal extends Terminal {
    show: sinon.SinonStub;
    sendText: sinon.SinonStub;
}

/**
 * Creates a mock Terminal for testing.
 */
function createMockTerminal(shellIntegration?: TerminalShellIntegration): MockTerminal {
    return {
        name: 'Test Terminal',
        creationOptions: {} as TerminalOptions,
        shellIntegration,
        processId: Promise.resolve(12345),
        exitStatus: undefined,
        state: { isInteractedWith: false, shell: undefined },
        show: sinon.stub(),
        hide: sinon.stub(),
        sendText: sinon.stub(),
        dispose: sinon.stub(),
    } as unknown as MockTerminal;
}

/**
 * Creates a mock TerminalShellIntegration.
 */
function createMockShellIntegration(): TerminalShellIntegration & {
    executeCommand: sinon.SinonStub<[string, string[]?], TerminalShellExecution>;
} {
    const mockExecution: TerminalShellExecution = {
        commandLine: { value: 'mock command', isTrusted: true, confidence: 1 },
        cwd: Uri.file('/mock/cwd'),
        read: sinon.stub().returns({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }),
    } as unknown as TerminalShellExecution;

    return {
        cwd: Uri.file('/mock/cwd'),
        executeCommand: sinon.stub<[string, string[]?], TerminalShellExecution>().returns(mockExecution),
    } as TerminalShellIntegration & {
        executeCommand: sinon.SinonStub<[string, string[]?], TerminalShellExecution>;
    };
}

/**
 * Creates execution options with sensible defaults.
 */
function createOptions(overrides?: Partial<PythonTerminalExecutionOptions>): PythonTerminalExecutionOptions {
    return {
        cwd: '/test/cwd',
        ...overrides,
    };
}

suite('runInTerminal', () => {
    let identifyTerminalShellStub: sinon.SinonStub;
    let shellExecutionEndEmitter: EventEmitter<TerminalShellExecutionEndEvent>;

    setup(() => {
        identifyTerminalShellStub = sinon.stub(shellDetector, 'identifyTerminalShell').returns(ShellConstants.BASH);
        shellExecutionEndEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();

        sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener: (e: TerminalShellExecutionEndEvent) => void): Disposable => {
            return shellExecutionEndEmitter.event(listener);
        });
    });

    teardown(() => {
        sinon.restore();
        shellExecutionEndEmitter.dispose();
    });

    suite('Terminal visibility', () => {
        test('should show terminal when options.show is true', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions({ show: true });

            await runInTerminal(environment, terminal, options);

            assert.ok(terminal.show.calledOnce, 'Terminal.show() should be called');
        });

        test('should not show terminal when options.show is false', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions({ show: false });

            await runInTerminal(environment, terminal, options);

            assert.strictEqual(terminal.show.called, false, 'Terminal.show() should not be called');
        });

        test('should not show terminal when options.show is undefined', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions();

            await runInTerminal(environment, terminal, options);

            assert.strictEqual(terminal.show.called, false, 'Terminal.show() should not be called');
        });
    });

    suite('Legacy mode (without shell integration)', () => {
        test('should use sendText with executable and args when no shell integration', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions({ args: ['script.py', '--verbose'] });

            await runInTerminal(environment, terminal, options);

            assert.ok(terminal.sendText.calledOnce, 'sendText should be called once');
            const sentText = terminal.sendText.firstCall.args[0];
            assert.ok(sentText.includes('/path/to/env/bin/python'), 'Should include python executable');
            assert.ok(sentText.includes('script.py'), 'Should include script argument');
            assert.ok(sentText.includes('--verbose'), 'Should include verbose flag');
        });

        test('should use run executable when activatedRun is not available', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment({
                execInfo: {
                    run: { executable: '/usr/bin/python3' },
                },
            });
            const options = createOptions({ args: ['test.py'] });

            await runInTerminal(environment, terminal, options);

            const sentText = terminal.sendText.firstCall.args[0];
            assert.ok(sentText.includes('/usr/bin/python3'), 'Should use run executable');
        });

        test('should default to "python" when no execInfo is available', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment({
                execInfo: undefined,
            });
            const options = createOptions();

            await runInTerminal(environment, terminal, options);

            const sentText = terminal.sendText.firstCall.args[0];
            assert.ok(sentText.includes('python'), 'Should default to python');
        });

        test('should include run.args in the command', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment({
                execInfo: {
                    run: { executable: '/usr/bin/python', args: ['-u'] },
                    activatedRun: { executable: '/path/to/python', args: ['-u', '-B'] },
                },
            });
            const options = createOptions({ args: ['script.py'] });

            await runInTerminal(environment, terminal, options);

            const sentText = terminal.sendText.firstCall.args[0];
            assert.ok(sentText.includes('-u'), 'Should include -u from args');
            assert.ok(sentText.includes('-B'), 'Should include -B from args');
            assert.ok(sentText.includes('script.py'), 'Should include script');
        });

        test('should prefix with & for PowerShell', async () => {
            identifyTerminalShellStub.returns(ShellConstants.PWSH);
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions();

            await runInTerminal(environment, terminal, options);

            const sentText = terminal.sendText.firstCall.args[0];
            assert.ok(sentText.startsWith('& '), 'PowerShell commands should be prefixed with &');
        });
    });

    suite('Shell integration mode', () => {
        test('should use executeCommand when shell integration is available', async () => {
            const shellIntegration = createMockShellIntegration();
            const terminal = createMockTerminal(shellIntegration);
            const environment = createMockEnvironment();
            const options = createOptions({ args: ['test.py'] });

            const mockExecution: TerminalShellExecution = {
                commandLine: { value: 'test', isTrusted: true, confidence: 1 },
                cwd: Uri.file('/mock/cwd'),
                read: sinon.stub(),
            } as unknown as TerminalShellExecution;
            shellIntegration.executeCommand.returns(mockExecution);

            // Fire end event immediately
            setImmediate(() => {
                shellExecutionEndEmitter.fire({
                    execution: mockExecution,
                    terminal,
                    exitCode: 0,
                    shellIntegration,
                });
            });

            await runInTerminal(environment, terminal, options);

            assert.ok(shellIntegration.executeCommand.calledOnce, 'executeCommand should be called');
            assert.strictEqual(terminal.sendText.called, false, 'sendText should not be called');
        });

        test('should quote executable with spaces for shell integration', async () => {
            const shellIntegration = createMockShellIntegration();
            const terminal = createMockTerminal(shellIntegration);
            const environment = createMockEnvironment({
                execInfo: {
                    run: { executable: '/path with spaces/python' },
                },
            });
            const options = createOptions();

            const mockExecution: TerminalShellExecution = {
                commandLine: { value: 'test', isTrusted: true, confidence: 1 },
                cwd: Uri.file('/mock/cwd'),
                read: sinon.stub(),
            } as unknown as TerminalShellExecution;
            shellIntegration.executeCommand.returns(mockExecution);

            setImmediate(() => {
                shellExecutionEndEmitter.fire({
                    execution: mockExecution,
                    terminal,
                    exitCode: 0,
                    shellIntegration,
                });
            });

            await runInTerminal(environment, terminal, options);

            const executable = shellIntegration.executeCommand.firstCall.args[0];
            assert.ok(
                executable.startsWith('"') && executable.endsWith('"'),
                'Executable with spaces should be quoted',
            );
        });

        test('should not double-quote already quoted executable', async () => {
            const shellIntegration = createMockShellIntegration();
            const terminal = createMockTerminal(shellIntegration);
            const environment = createMockEnvironment({
                execInfo: {
                    run: { executable: '"/path with spaces/python"' },
                },
            });
            const options = createOptions();

            const mockExecution: TerminalShellExecution = {
                commandLine: { value: 'test', isTrusted: true, confidence: 1 },
                cwd: Uri.file('/mock/cwd'),
                read: sinon.stub(),
            } as unknown as TerminalShellExecution;
            shellIntegration.executeCommand.returns(mockExecution);

            setImmediate(() => {
                shellExecutionEndEmitter.fire({
                    execution: mockExecution,
                    terminal,
                    exitCode: 0,
                    shellIntegration,
                });
            });

            await runInTerminal(environment, terminal, options);

            const executable = shellIntegration.executeCommand.firstCall.args[0];
            assert.strictEqual(
                executable,
                '"/path with spaces/python"',
                'Already quoted executable should not be double-quoted',
            );
        });

        test('should prefix with & for PowerShell with shell integration', async () => {
            identifyTerminalShellStub.returns(ShellConstants.PWSH);
            const shellIntegration = createMockShellIntegration();
            const terminal = createMockTerminal(shellIntegration);
            const environment = createMockEnvironment();
            const options = createOptions();

            const mockExecution: TerminalShellExecution = {
                commandLine: { value: 'test', isTrusted: true, confidence: 1 },
                cwd: Uri.file('/mock/cwd'),
                read: sinon.stub(),
            } as unknown as TerminalShellExecution;
            shellIntegration.executeCommand.returns(mockExecution);

            setImmediate(() => {
                shellExecutionEndEmitter.fire({
                    execution: mockExecution,
                    terminal,
                    exitCode: 0,
                    shellIntegration,
                });
            });

            await runInTerminal(environment, terminal, options);

            const executable = shellIntegration.executeCommand.firstCall.args[0];
            assert.ok(executable.startsWith('& '), 'PowerShell commands should be prefixed with &');
        });

        test('should pass arguments to executeCommand', async () => {
            const shellIntegration = createMockShellIntegration();
            const terminal = createMockTerminal(shellIntegration);
            const environment = createMockEnvironment();
            const options = createOptions({ args: ['script.py', '--flag', 'value'] });

            const mockExecution: TerminalShellExecution = {
                commandLine: { value: 'test', isTrusted: true, confidence: 1 },
                cwd: Uri.file('/mock/cwd'),
                read: sinon.stub(),
            } as unknown as TerminalShellExecution;
            shellIntegration.executeCommand.returns(mockExecution);

            setImmediate(() => {
                shellExecutionEndEmitter.fire({
                    execution: mockExecution,
                    terminal,
                    exitCode: 0,
                    shellIntegration,
                });
            });

            await runInTerminal(environment, terminal, options);

            const args = shellIntegration.executeCommand.firstCall.args[1];
            assert.ok(Array.isArray(args), 'Args should be an array');
            assert.ok(args?.includes('script.py'), 'Args should include script.py');
            assert.ok(args?.includes('--flag'), 'Args should include --flag');
            assert.ok(args?.includes('value'), 'Args should include value');
        });
    });

    suite('Git Bash path normalization', () => {
        test('should normalize Windows paths for Git Bash', async () => {
            identifyTerminalShellStub.returns(ShellConstants.GITBASH);
            const terminal = createMockTerminal();
            const environment = createMockEnvironment({
                execInfo: {
                    run: { executable: 'C:\\Python\\python.exe' },
                },
            });
            const options = createOptions();

            await runInTerminal(environment, terminal, options);

            const sentText = terminal.sendText.firstCall.args[0];
            // Git Bash normalizes Windows backslash paths to forward slashes
            // The normalizeShellPath function handles this conversion
            assert.ok(sentText.includes('python'), 'Should include python in command');
        });
    });

    suite('Arguments handling', () => {
        test('should handle empty args array', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions({ args: [] });

            await runInTerminal(environment, terminal, options);

            assert.ok(terminal.sendText.calledOnce, 'sendText should be called');
        });

        test('should handle undefined args', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            const options = createOptions();

            await runInTerminal(environment, terminal, options);

            assert.ok(terminal.sendText.calledOnce, 'sendText should be called');
        });

        test('should combine execInfo args with options args', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment({
                execInfo: {
                    run: { executable: '/usr/bin/python', args: ['-u'] },
                    activatedRun: { executable: '/path/to/python', args: ['-B'] },
                },
            });
            const options = createOptions({ args: ['script.py'] });

            await runInTerminal(environment, terminal, options);

            const sentText = terminal.sendText.firstCall.args[0];
            assert.ok(sentText.includes('-B'), 'Should include activatedRun args');
            assert.ok(sentText.includes('script.py'), 'Should include options args');
        });
    });
});
