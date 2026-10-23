import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, Terminal, TerminalShellExecution, TerminalShellExecutionEndEvent } from 'vscode';
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

        sinon.assert.calledOnceWithExactly(waitForShellIntegrationStub, terminal, terminalUtils.SHELL_INTEGRATION_TIMEOUT);
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

        sinon.assert.calledOnceWithExactly(waitForShellIntegrationStub, terminal, terminalUtils.SHELL_INTEGRATION_TIMEOUT);
        sinon.assert.calledOnceWithExactly(sendText, 'python main.py\n');
    });

    test('preserves special characters in POSIX shell arguments with shell integration', async () => {
        const identifyTerminalShellStub = sinon.stub(shellDetector, 'identifyTerminalShell');
        const execution = {} as TerminalShellExecution;
        const executeCommand = sinon.stub().returns(execution);
        const terminal = {
            name: 'Python',
            shellIntegration: { executeCommand },
            sendText: sinon.stub(),
        } as unknown as Terminal;

        let endListener: ((event: TerminalShellExecutionEndEvent) => void) | undefined;
        sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener) => {
            endListener = listener;
            return new Disposable(() => undefined);
        });

        const environment = createMockPythonEnvironment({ envPath: '/env/bin/python' });
        const cases = [
            ['/workspace/cost$AUDIT_UNSET.py', 'python /workspace/cost\\$AUDIT_UNSET.py'],
            ["/workspace/it's_python.py", 'python "/workspace/it\'s_python.py"'],
            ['=report.py', 'python \\=report.py'],
            ['/workspace/$(touch marker).py', "python '/workspace/$(touch marker).py'"],
        ];

        let callIndex = 0;
        for (const shell of posixShells) {
            identifyTerminalShellStub.returns(shell);
            for (const [script, command] of cases) {
                const runPromise = runInTerminal(environment, terminal, { cwd: '/workspace', args: [script] });
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.deepStrictEqual(executeCommand.getCall(callIndex).args, [command]);
                assert.ok(endListener, 'shell execution end listener should be registered');
                endListener!({ terminal, execution } as unknown as TerminalShellExecutionEndEvent);
                await runPromise;
                callIndex += 1;
            }
        }
        sinon.assert.callCount(executeCommand, posixShells.length * cases.length);
    });

    test('preserves special characters in POSIX shell arguments without shell integration', async () => {
        const identifyTerminalShellStub = sinon.stub(shellDetector, 'identifyTerminalShell');
        sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
        const sendText = sinon.stub();
        const environment = createMockPythonEnvironment({ envPath: '/env/bin/python' });
        const cases = [
            ['/workspace/cost$AUDIT_UNSET.py', 'python /workspace/cost\\$AUDIT_UNSET.py\n'],
            ["/workspace/it's_python.py", 'python "/workspace/it\'s_python.py"\n'],
            ['=report.py', 'python \\=report.py\n'],
            ['/workspace/$(touch marker).py', "python '/workspace/$(touch marker).py'\n"],
        ];

        let callIndex = 0;
        for (const shell of posixShells) {
            identifyTerminalShellStub.returns(shell);
            const terminal = {
                name: 'Python',
                shellIntegration: undefined,
                sendText,
            } as unknown as Terminal;
            for (const [script, command] of cases) {
                await runInTerminal(environment, terminal, { cwd: '/workspace', args: [script] });
                assert.deepStrictEqual(sendText.getCall(callIndex).args, [command]);
                callIndex += 1;
            }
        }
        sinon.assert.callCount(sendText, posixShells.length * cases.length);
    });

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
        sinon.assert.calledOnceWithExactly(waitForShellIntegrationStub, terminal, terminalUtils.SHELL_INTEGRATION_TIMEOUT);
        sinon.assert.calledTwice(sendText);
        sinon.assert.calledTwice(sendText);
    });
});
