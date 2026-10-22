import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, Terminal, TerminalShellExecution, TerminalShellExecutionEndEvent } from 'vscode';
import * as windowApis from '../../../common/window.apis';
import * as shellDetector from '../../../features/common/shellDetector';
import { runInTerminal } from '../../../features/terminal/runInTerminal';
import * as terminalUtils from '../../../features/terminal/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('runInTerminal', () => {
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

        sinon.assert.calledOnce(waitForShellIntegrationStub);
        sinon.assert.notCalled(terminal.sendText as sinon.SinonStub);
        sinon.assert.notCalled(shellIntegration.executeCommand);

        (terminal as { shellIntegration?: typeof shellIntegration }).shellIntegration = shellIntegration;
        resolveWaitForShellIntegration(true);
        await new Promise<void>((resolve) => setImmediate(resolve));

        sinon.assert.notCalled(terminal.sendText as sinon.SinonStub);
        sinon.assert.calledOnce(shellIntegration.executeCommand);
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

        sinon.assert.calledOnceWithExactly(waitForShellIntegrationStub, terminal);
        sinon.assert.calledOnceWithExactly(sendText, 'python main.py\n');
    });

    test('preserves special characters in zsh script paths with shell integration', async () => {
        sinon.stub(shellDetector, 'identifyTerminalShell').returns('zsh');
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
            ['/workspace/cost$AUDIT_UNSET.py', "python '/workspace/cost$AUDIT_UNSET.py'"],
            ["/workspace/it's_python.py", "python '/workspace/it'\\''s_python.py'"],
        ];

        for (const [script, command] of cases) {
            const runPromise = runInTerminal(environment, terminal, { cwd: '/workspace', args: [script] });
            await new Promise<void>((resolve) => setImmediate(resolve));
            sinon.assert.calledWithExactly(executeCommand, command);
            assert.ok(endListener, 'shell execution end listener should be registered');
            endListener!({ terminal, execution } as unknown as TerminalShellExecutionEndEvent);
            await runPromise;
        }
    });

    test('preserves special characters in zsh script paths without shell integration', async () => {
        sinon.stub(shellDetector, 'identifyTerminalShell').returns('zsh');
        sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
        const sendText = sinon.stub();
        const terminal = {
            name: 'Python',
            shellIntegration: undefined,
            sendText,
        } as unknown as Terminal;
        const environment = createMockPythonEnvironment({ envPath: '/env/bin/python' });

        await runInTerminal(environment, terminal, {
            cwd: '/workspace',
            args: ['/workspace/cost$AUDIT_UNSET.py'],
        });
        await runInTerminal(environment, terminal, {
            cwd: '/workspace',
            args: ["/workspace/it's_python.py"],
        });

        sinon.assert.calledWithExactly(sendText, "python '/workspace/cost$AUDIT_UNSET.py'\n");
        sinon.assert.calledWithExactly(sendText, "python '/workspace/it'\\''s_python.py'\n");
    });
});
