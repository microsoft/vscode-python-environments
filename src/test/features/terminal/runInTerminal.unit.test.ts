import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, Terminal, TerminalShellExecution, TerminalShellExecutionEndEvent, Uri } from 'vscode';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as windowApis from '../../../common/window.apis';
import { ShellConstants } from '../../../features/common/shellConstants';
import * as shellDetector from '../../../features/common/shellDetector';
import { runInTerminal } from '../../../features/terminal/runInTerminal';
import * as terminalUtils from '../../../features/terminal/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('runInTerminal', () => {
    const posixShells = [
        ShellConstants.SH,
        ShellConstants.BASH,
        ShellConstants.ZSH,
        ShellConstants.KSH,
        ShellConstants.GITBASH,
    ];

    teardown(() => {
        sinon.restore();
    });

    test('waits for shell integration before executing a command', async () => {
        sinon.stub(shellDetector, 'identifyTerminalShell').returns('fish');
        const waitForShellIntegrationStub = sinon.stub(terminalUtils, 'waitForShellIntegration');
        let resolveWaitForShellIntegration!: (result: boolean) => void;
        const waitForShellIntegrationPromise = new Promise<boolean>((resolve) => {
            resolveWaitForShellIntegration = resolve;
        });

        const execution = {} as TerminalShellExecution;
        const shellIntegration = {
            executeCommand: sinon.stub().returns(execution),
        };
        const terminal = {
            name: 'Python',
            shellIntegration: undefined,
            sendText: sinon.stub(),
        } as unknown as Terminal;
        waitForShellIntegrationStub.returns(waitForShellIntegrationPromise);

        let endListener: ((event: TerminalShellExecutionEndEvent) => void) | undefined;
        sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener) => {
            endListener = listener;
            return new Disposable(() => undefined);
        });

        const environment = createMockPythonEnvironment({ envPath: '/env/bin/python' });
        const runPromise = runInTerminal(environment, terminal, { cwd: '/workspace', args: ['main.py'] });
        await new Promise<void>((resolve) => setImmediate(resolve));

        sinon.assert.calledOnceWithExactly(
            waitForShellIntegrationStub,
            terminal,
            terminalUtils.SHELL_INTEGRATION_TIMEOUT,
        );
        sinon.assert.notCalled(terminal.sendText as sinon.SinonStub);
        sinon.assert.notCalled(shellIntegration.executeCommand);

        (terminal as { shellIntegration?: typeof shellIntegration }).shellIntegration = shellIntegration;
        resolveWaitForShellIntegration(true);
        await new Promise<void>((resolve) => setImmediate(resolve));

        sinon.assert.notCalled(terminal.sendText as sinon.SinonStub);
        sinon.assert.calledOnceWithExactly(shellIntegration.executeCommand, 'python', ['main.py']);
        assert.ok(endListener, 'shell execution end listener should be registered');

        endListener!({ terminal, execution } as unknown as TerminalShellExecutionEndEvent);
        await runPromise;
    });

    test('uses sendText when shell integration is unavailable after waiting', async () => {
        sinon.stub(shellDetector, 'identifyTerminalShell').returns('fish');
        const waitForShellIntegrationStub = sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
        const sendText = sinon.stub();
        const terminal = {
            name: 'Python',
            shellIntegration: undefined,
            sendText,
        } as unknown as Terminal;

        const environment = createMockPythonEnvironment({ envPath: '/env/bin/python' });
        await runInTerminal(environment, terminal, { cwd: '/workspace', args: ['main.py'] });

        sinon.assert.calledOnceWithExactly(
            waitForShellIntegrationStub,
            terminal,
            terminalUtils.SHELL_INTEGRATION_TIMEOUT,
        );
        sinon.assert.calledOnceWithExactly(sendText, 'python main.py\n');
    });

    test('detects the shell after terminal initialization before quoting', async () => {
        const shellStub = sinon.stub(shellDetector, 'identifyTerminalShell').returns('pwsh');
        sinon.stub(terminalUtils, 'waitForShellIntegration').callsFake(async () => {
            shellStub.returns('bash');
            return false;
        });
        const sendText = sinon.stub();
        const terminal = {
            name: 'Python',
            shellIntegration: undefined,
            sendText,
        } as unknown as Terminal;
        const cwd = Uri.file(path.resolve('workspace'));
        const environment = createMockPythonEnvironment({ envPath: path.join(cwd.fsPath, 'python') });

        await runInTerminal(environment, terminal, { cwd, args: ['$(touch marker).py'] });

        sinon.assert.calledOnceWithExactly(sendText, "python '$(touch marker).py'\n");
    });

    for (const shell of [...posixShells, ShellConstants.PWSH]) {
        for (const integration of [true, false]) {
            test(`preserves literal arguments in ${shell} with shell integration ${integration}`, async () => {
                sinon.stub(shellDetector, 'identifyTerminalShell').returns(shell);
                sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
                const execution = {} as TerminalShellExecution;
                const executeCommand = sinon.stub().returns(execution);
                const sendText = sinon.stub();
                const terminal = {
                    name: 'Python',
                    shellIntegration: integration ? { executeCommand } : undefined,
                    sendText,
                } as unknown as Terminal;
                let endListener: ((event: TerminalShellExecutionEndEvent) => void) | undefined;
                sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener) => {
                    endListener = listener;
                    return new Disposable(() => undefined);
                });
                const cwd = Uri.file(path.resolve('workspace'));
                const environment = createMockPythonEnvironment({ envPath: path.join(cwd.fsPath, 'python') });
                const cases =
                    shell === 'pwsh'
                        ? [
                              ['cost$AUDIT_UNSET.py', "& 'python' 'cost$AUDIT_UNSET.py'"],
                              ["it's_python.py", "& 'python' 'it''s_python.py'"],
                              ['O\u2018Connor report.py', "& 'python' 'O\u2018\u2018Connor report.py'"],
                              ['O\u2019Connor report.py', "& 'python' 'O\u2019\u2019Connor report.py'"],
                              ['O\u201aConnor report.py', "& 'python' 'O\u201a\u201aConnor report.py'"],
                              ['O\u201bConnor report.py', "& 'python' 'O\u201b\u201bConnor report.py'"],
                              ['=report.py', "& 'python' '=report.py'"],
                              ['$(touch marker).py', "& 'python' '$(touch marker).py'"],
                              ['`whoami`.py', "& 'python' '`whoami`.py'"],
                              ['"quoted".py', "& 'python' '\"quoted\".py'"],
                              ['', "& 'python' ''"],
                              [';', "& 'python' ';'"],
                          ]
                        : [
                              ['cost$AUDIT_UNSET.py', 'python cost\\$AUDIT_UNSET.py'],
                              ["it's_python.py", 'python "it\'s_python.py"'],
                              ['=report.py', 'python \\=report.py'],
                              ['$(touch marker).py', "python '$(touch marker).py'"],
                              ['`whoami`.py', 'python \\`whoami\\`.py'],
                              ['"quoted".py', 'python \'"quoted".py\''],
                              ['', "python ''"],
                              [';', 'python \\;'],
                          ];

                for (const [arg, command] of cases) {
                    executeCommand.resetHistory();
                    sendText.resetHistory();
                    const runPromise = runInTerminal(environment, terminal, { cwd, args: [arg] });
                    if (integration) {
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        sinon.assert.calledOnceWithExactly(executeCommand, command);
                        sinon.assert.notCalled(sendText);
                        assert.ok(endListener, 'shell execution end listener should be registered');
                        endListener({ terminal, execution } as TerminalShellExecutionEndEvent);
                    }
                    await runPromise;
                    if (!integration) {
                        sinon.assert.calledOnceWithExactly(sendText, `${command}\n`);
                        sinon.assert.notCalled(executeCommand);
                    }
                }
            });
        }
    }

    for (const shell of ['gitbash', 'pwsh']) {
        for (const integration of [true, false]) {
            for (const activated of [true, false]) {
                test(`quotes ${shell} executable paths and preserves ${activated ? 'activated' : 'run'} arguments with shell integration ${integration}`, async () => {
                    sinon.stub(shellDetector, 'identifyTerminalShell').returns(shell);
                    sinon.stub(platformUtils, 'isWindows').returns(true);
                    sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
                    const execution = {} as TerminalShellExecution;
                    const executeCommand = sinon.stub().returns(execution);
                    const sendText = sinon.stub();
                    const terminal = {
                        name: 'Python',
                        shellIntegration: integration ? { executeCommand } : undefined,
                        sendText,
                    } as unknown as Terminal;
                    let endListener: ((event: TerminalShellExecutionEndEvent) => void) | undefined;
                    sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener) => {
                        endListener = listener;
                        return new Disposable(() => undefined);
                    });
                    const executable = path.win32.join('C:\\', "Python's \u2018\u2019\u201a\u201b $home", 'python.exe');
                    const cwd = Uri.file(path.resolve('workspace'));
                    const base = createMockPythonEnvironment({ envPath: executable });
                    const run = { executable, args: ['-I'] };
                    const environment = {
                        ...base,
                        execInfo: {
                            run: activated ? { executable: 'unused', args: ['--unused'] } : run,
                            ...(activated ? { activatedRun: run } : {}),
                        },
                    };
                    const runPromise = runInTerminal(environment, terminal, { cwd, args: ['main.py', ''] });
                    const expected =
                        shell === 'pwsh'
                            ? "& 'C:\\Python''s \u2018\u2018\u2019\u2019\u201a\u201a\u201b\u201b $home\\python.exe' '-I' 'main.py' ''"
                            : "\"C:/Python's \u2018\u2019\u201a\u201b \\$home/python.exe\" -I main.py ''";
                    if (integration) {
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        sinon.assert.calledOnceWithExactly(executeCommand, expected);
                        assert.ok(endListener);
                        endListener({ terminal, execution } as TerminalShellExecutionEndEvent);
                    }
                    await runPromise;
                    if (!integration) {
                        sinon.assert.calledOnceWithExactly(sendText, `${expected}\n`);
                    }
                });
            }
        }
    }

    test('does not wait again when reusing a terminal without shell integration', async () => {
        sinon.stub(shellDetector, 'identifyTerminalShell').returns('fish');
        const waitForShellIntegrationStub = sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
        const sendText = sinon.stub();
        const terminal = {
            name: 'Python',
            shellIntegration: undefined,
            sendText,
        } as unknown as Terminal;

        const environment = createMockPythonEnvironment({ envPath: '/env/bin/python' });
        const options = { cwd: '/workspace', args: ['main.py'] };
        await runInTerminal(environment, terminal, options);
        await runInTerminal(environment, terminal, options);
        sinon.assert.calledOnceWithExactly(
            waitForShellIntegrationStub,
            terminal,
            terminalUtils.SHELL_INTEGRATION_TIMEOUT,
        );
        sinon.assert.calledTwice(sendText);
        sinon.assert.calledTwice(sendText);
    });
});
