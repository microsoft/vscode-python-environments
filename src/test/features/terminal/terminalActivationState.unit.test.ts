import * as assert from 'assert';
import * as sinon from 'sinon';
import {
    EventEmitter,
    Terminal,
    TerminalShellExecution,
    TerminalShellExecutionEndEvent,
    TerminalShellExecutionStartEvent,
    TerminalShellIntegration,
    Uri,
} from 'vscode';
import { PythonEnvironment } from '../../../api';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetry from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import * as activationCommands from '../../../features/common/activation';
import * as shellDetector from '../../../features/common/shellDetector';
import { TerminalActivationImpl } from '../../../features/terminal/terminalActivationState';
import * as terminalUtils from '../../../features/terminal/utils';

suite('TerminalActivation - command outcomes', () => {
    let activation: TerminalActivationImpl;
    let ends: EventEmitter<TerminalShellExecutionEndEvent>;
    let starts: EventEmitter<TerminalShellExecutionStartEvent>;
    let clock: sinon.SinonFakeTimers;
    let sendTelemetry: sinon.SinonStub;
    let executeCommand: sinon.SinonStub;
    let sendText: sinon.SinonStub;
    let terminal: Terminal;
    const execution = {} as TerminalShellExecution;
    const environment: PythonEnvironment = {
        envId: { id: 'test-env', managerId: 'test-manager' },
        name: 'Test',
        displayName: 'Test',
        displayPath: 'Test',
        version: '3.12',
        environmentPath: Uri.file('test-env'),
        sysPrefix: Uri.file('test-env').fsPath,
        execInfo: { run: { executable: 'python' } },
    };

    setup(() => {
        clock = sinon.useFakeTimers();
        ends = new EventEmitter<TerminalShellExecutionEndEvent>();
        starts = new EventEmitter<TerminalShellExecutionStartEvent>();
        sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener) => ends.event(listener));
        sinon.stub(windowApis, 'onDidStartTerminalShellExecution').callsFake((listener) => starts.event(listener));
        sinon.stub(windowApis, 'onDidCloseTerminal').returns({ dispose() {} });
        sinon.stub(terminalUtils, 'shouldSkipTerminalActivation').returns(false);
        sinon.stub(terminalUtils, 'isTaskTerminal').returns(false);
        sinon.stub(terminalUtils, 'getShellIntegrationTimeout').returns(500);
        sinon.stub(shellDetector, 'identifyTerminalShell').returns('bash');
        sinon.stub(activationCommands, 'getActivationCommand').returns('activate');
        sinon.stub(activationCommands, 'getDeactivationCommand').returns('deactivate');
        sendTelemetry = sinon.stub(telemetry, 'sendTelemetryEvent');
        executeCommand = sinon.stub().returns(execution);
        sendText = sinon.stub();
        terminal = {
            shellIntegration: { executeCommand } as unknown as TerminalShellIntegration,
            sendText,
        } as unknown as Terminal;
        activation = new TerminalActivationImpl();
    });

    teardown(() => {
        activation.dispose();
        ends.dispose();
        starts.dispose();
        clock.restore();
        sinon.restore();
    });

    function finish(exitCode?: number): void {
        ends.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution, exitCode });
    }

    function expectOutcome(operation: 'activate' | 'deactivate', outcome: string, method = 'shellIntegration'): void {
        const event = sendTelemetry.getCalls().find((call) => call.args[2]?.operation === operation);
        assert.ok(event, `Expected ${operation} telemetry`);
        assert.strictEqual(event.args[0], EventNames.TERMINAL_ACTIVATION_OUTCOME);
        assert.strictEqual(event.args[2].outcome, outcome);
        assert.strictEqual(event.args[2].method, method);
        assert.strictEqual(event.args[2].shell, 'bash');
        assert.strictEqual(typeof event.args[1], 'number');
        assert.deepStrictEqual(Object.keys(event.args[2]).sort(), ['method', 'operation', 'outcome', 'shell', 'trigger']);
    }

    test('marks activation only after exit code zero', async () => {
        const pending = activation.activate(terminal, environment, 'terminalOpen');
        assert.strictEqual(activation.isActivated(terminal), false);
        finish(0);
        await pending;
        assert.strictEqual(activation.isActivated(terminal), true);
        expectOutcome('activate', 'succeeded');
        assert.strictEqual(sendTelemetry.firstCall.args[2].trigger, 'terminalOpen');
    });

    test('nonzero exit code does not mark activation', async () => {
        const pending = activation.activate(terminal, environment);
        finish(1);
        await pending;
        assert.strictEqual(activation.isActivated(terminal), false);
        expectOutcome('activate', 'failed');
    });

    test('missing exit code is unknown rather than success', async () => {
        const pending = activation.activate(terminal, environment);
        finish();
        await pending;
        assert.strictEqual(activation.isActivated(terminal), false);
        expectOutcome('activate', 'unknown');
    });

    test('timeout is unconfirmed, and a late completion cannot update state', async () => {
        const pending = activation.activate(terminal, environment);
        await clock.tickAsync(500);
        await pending;
        assert.strictEqual(activation.isActivated(terminal), false);
        expectOutcome('activate', 'timedOut');
        assert.strictEqual(sendTelemetry.firstCall.args[1], 500);
        finish(0);
        assert.strictEqual(activation.isActivated(terminal), false);
        assert.strictEqual(sendTelemetry.callCount, 1);
    });

    test('executeCommand throwing reports failure without changing state', async () => {
        executeCommand.throws(new Error('execution failed'));
        await activation.activate(terminal, environment);
        assert.strictEqual(activation.isActivated(terminal), false);
        expectOutcome('activate', 'failed');
    });

    test('failed deactivation preserves state', async () => {
        const initial = activation.activate(terminal, environment);
        finish(0);
        await initial;
        sendTelemetry.resetHistory();

        const pending = activation.deactivate(terminal);
        finish(1);
        await pending;
        assert.strictEqual(activation.getEnvironment(terminal), environment);
        expectOutcome('deactivate', 'failed');
    });

    test('timed-out deactivation keeps the last confirmed environment', async () => {
        const initial = activation.activate(terminal, environment);
        finish(0);
        await initial;
        sendTelemetry.resetHistory();

        const pending = activation.deactivate(terminal);
        await clock.tickAsync(500);
        await pending;
        assert.strictEqual(activation.getEnvironment(terminal), environment);
        expectOutcome('deactivate', 'timedOut');
    });

    test('a stale deactivation failure does not permanently block replacement activation', async () => {
        const initial = activation.activate(terminal, environment);
        finish(0);
        await initial;
        sendTelemetry.resetHistory();
        const replacement: PythonEnvironment = {
            ...environment,
            envId: { id: 'replacement', managerId: environment.envId.managerId },
        };
        const activationStarted = new Promise<void>((resolve) => {
            executeCommand.onThirdCall().callsFake(() => {
                resolve();
                return execution;
            });
        });
        const pending = activation.activate(terminal, replacement);
        finish(1);
        assert.strictEqual(activation.getEnvironment(terminal), environment);
        await activationStarted;
        finish(0);
        await pending;
        assert.strictEqual(activation.getEnvironment(terminal), replacement);
        assert.strictEqual(executeCommand.callCount, 3);
        expectOutcome('deactivate', 'failed');
        expectOutcome('activate', 'succeeded');
    });

    test('sendText remains optimistic but is reported as unverified', async () => {
        terminal = { sendText } as unknown as Terminal;
        await activation.activate(terminal, environment);
        assert.strictEqual(activation.isActivated(terminal), true);
        sinon.assert.calledOnceWithExactly(sendText, 'activate');
        expectOutcome('activate', 'unverified', 'sendText');
    });

    test('missing activation command does not change state', async () => {
        (activationCommands.getActivationCommand as sinon.SinonStub).returns(undefined);
        await activation.activate(terminal, environment);
        assert.strictEqual(activation.isActivated(terminal), false);
        expectOutcome('activate', 'noCommand');
    });
});
