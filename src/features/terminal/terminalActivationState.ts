import {
    Disposable,
    Event,
    EventEmitter,
    Terminal,
    TerminalShellExecutionEndEvent,
    TerminalShellExecutionStartEvent,
    TerminalShellIntegration,
} from 'vscode';
import { PythonEnvironment } from '../../api';
import { traceError, traceInfo, traceVerbose } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { onDidEndTerminalShellExecution, onDidStartTerminalShellExecution } from '../../common/window.apis';
import { getActivationCommand, getDeactivationCommand } from '../common/activation';
import { identifyTerminalShell } from '../common/shellDetector';
import { getShellIntegrationTimeout, isTaskTerminal, shouldSkipTerminalActivation } from './utils';

type ActivationTrigger = 'terminalOpen' | 'preExisting' | 'explicit' | 'environmentSwitch' | 'unknown';
type CommandOutcome = 'succeeded' | 'failed' | 'timedOut' | 'unknown' | 'unverified' | 'noCommand';

export interface DidChangeTerminalActivationStateEvent {
    terminal: Terminal;
    environment: PythonEnvironment;
    activated: boolean;
}

export interface TerminalActivation {
    isActivated(terminal: Terminal, environment?: PythonEnvironment): boolean;
    activate(terminal: Terminal, environment: PythonEnvironment, trigger?: ActivationTrigger): Promise<void>;
    deactivate(terminal: Terminal, trigger?: ActivationTrigger): Promise<void>;
    onDidChangeTerminalActivationState: Event<DidChangeTerminalActivationStateEvent>;
}

export interface TerminalEnvironment {
    getEnvironment(terminal: Terminal): PythonEnvironment | undefined;
}

export interface TerminalActivationInternal extends TerminalActivation, TerminalEnvironment, Disposable {
    updateActivationState(terminal: Terminal, environment: PythonEnvironment, activated: boolean): void;
}

export class TerminalActivationImpl implements TerminalActivationInternal {
    private disposables: Disposable[] = [];

    private onTerminalShellExecutionStartEmitter = new EventEmitter<TerminalShellExecutionStartEvent>();
    private onTerminalShellExecutionStart = this.onTerminalShellExecutionStartEmitter.event;

    private onTerminalShellExecutionEndEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();
    private onTerminalShellExecutionEnd = this.onTerminalShellExecutionEndEmitter.event;

    private onDidChangeTerminalActivationStateEmitter = new EventEmitter<DidChangeTerminalActivationStateEvent>();
    onDidChangeTerminalActivationState = this.onDidChangeTerminalActivationStateEmitter.event;

    private onTerminalClosedEmitter = new EventEmitter<Terminal>();
    private onTerminalClosed = this.onTerminalClosedEmitter.event;

    private activatedTerminals = new Map<Terminal, PythonEnvironment>();
    private activatingTerminals = new Map<Terminal, Promise<CommandOutcome>>();
    private deactivatingTerminals = new Map<Terminal, Promise<CommandOutcome>>();

    constructor() {
        this.disposables.push(
            this.onDidChangeTerminalActivationStateEmitter,
            this.onTerminalShellExecutionStartEmitter,
            this.onTerminalShellExecutionEndEmitter,
            this.onTerminalClosedEmitter,
            onDidStartTerminalShellExecution((e: TerminalShellExecutionStartEvent) => {
                this.onTerminalShellExecutionStartEmitter.fire(e);
            }),
            onDidEndTerminalShellExecution((e: TerminalShellExecutionEndEvent) => {
                this.onTerminalShellExecutionEndEmitter.fire(e);
            }),
            this.onTerminalClosed((terminal) => {
                this.activatedTerminals.delete(terminal);
                this.activatingTerminals.delete(terminal);
                this.deactivatingTerminals.delete(terminal);
            }),
        );
    }

    isActivated(terminal: Terminal, environment?: PythonEnvironment): boolean {
        if (!environment) {
            return this.activatedTerminals.has(terminal);
        }
        const env = this.activatedTerminals.get(terminal);
        return env?.envId.id === environment?.envId.id;
    }

    getEnvironment(terminal: Terminal): PythonEnvironment | undefined {
        return this.activatedTerminals.get(terminal);
    }

    async activate(
        terminal: Terminal,
        environment: PythonEnvironment,
        trigger: ActivationTrigger = 'unknown',
    ): Promise<void> {
        if (shouldSkipTerminalActivation(terminal)) {
            traceVerbose('Skipping activation for this terminal');
            return;
        }

        if (isTaskTerminal(terminal)) {
            traceVerbose('Cannot activate environment in a task terminal');
            return;
        }

        if (this.deactivatingTerminals.has(terminal)) {
            traceVerbose('Terminal is being deactivated, cannot activate.');
            await this.deactivatingTerminals.get(terminal);
            return;
        }

        if (this.activatingTerminals.has(terminal)) {
            traceVerbose('Terminal is being activated, skipping.');
            await this.activatingTerminals.get(terminal);
            return;
        }

        const terminalEnv = this.activatedTerminals.get(terminal);
        if (terminalEnv) {
            if (terminalEnv.envId.id === environment.envId.id) {
                traceVerbose('Terminal is already activated with the same environment');
                return;
            } else {
                traceInfo(
                    `Terminal is activated with a different environment, deactivating: ${terminalEnv.environmentPath.fsPath}`,
                );
                await this.deactivate(terminal, 'environmentSwitch');
            }
        }

        try {
            const promise = this.runCommand(terminal, environment, 'activate', trigger);
            traceVerbose(`Activating terminal: ${environment.environmentPath.fsPath}`);
            this.activatingTerminals.set(terminal, promise);
            const outcome = await promise;
            this.activatingTerminals.delete(terminal);
            if (outcome === 'succeeded' || outcome === 'unverified') {
                // sendText has no completion signal; preserve its existing optimistic UI behavior.
                this.updateActivationState(terminal, environment, true);
                traceInfo(`Terminal activation sent: ${environment.environmentPath.fsPath} (${outcome})`);
            }
        } catch (ex) {
            this.activatingTerminals.delete(terminal);
            traceError('Failed to activate environment:\r\n', ex);
        }
    }

    async deactivate(terminal: Terminal, trigger: ActivationTrigger = 'unknown'): Promise<void> {
        if (isTaskTerminal(terminal)) {
            traceVerbose('Cannot deactivate environment in a task terminal');
            return;
        }

        if (this.activatingTerminals.has(terminal)) {
            traceVerbose('Terminal is being activated, cannot deactivate.');
            await this.activatingTerminals.get(terminal);
            return;
        }

        if (this.deactivatingTerminals.has(terminal)) {
            traceVerbose('Terminal is being deactivated, skipping.');
            await this.deactivatingTerminals.get(terminal);
            return;
        }

        const terminalEnv = this.activatedTerminals.get(terminal);
        if (terminalEnv) {
            try {
                const promise = this.runCommand(terminal, terminalEnv, 'deactivate', trigger);
                traceVerbose(`Deactivating terminal: ${terminalEnv.environmentPath.fsPath}`);
                this.deactivatingTerminals.set(terminal, promise);
                const outcome = await promise;
                this.deactivatingTerminals.delete(terminal);
                if (outcome === 'succeeded' || outcome === 'unverified') {
                    this.updateActivationState(terminal, terminalEnv, false);
                    traceInfo(`Terminal deactivation sent: ${terminalEnv.environmentPath.fsPath} (${outcome})`);
                }
            } catch (ex) {
                this.deactivatingTerminals.delete(terminal);
                traceError('Failed to deactivate environment:\r\n', ex);
            }
        } else {
            traceVerbose('Terminal is not activated');
        }
    }

    updateActivationState(terminal: Terminal, environment: PythonEnvironment, activated: boolean): void {
        if (activated) {
            this.activatedTerminals.set(terminal, environment);
        } else {
            this.activatedTerminals.delete(terminal);
        }
        setImmediate(() => {
            this.onDidChangeTerminalActivationStateEmitter.fire({ terminal, environment, activated });
        });
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }

    private async runCommand(
        terminal: Terminal,
        environment: PythonEnvironment,
        operation: 'activate' | 'deactivate',
        trigger: ActivationTrigger,
    ): Promise<CommandOutcome> {
        const watch = new StopWatch();
        const method = terminal.shellIntegration ? 'shellIntegration' : 'sendText';
        let outcome: CommandOutcome = 'failed';
        try {
            const command =
                operation === 'activate'
                    ? getActivationCommand(terminal, environment)
                    : getDeactivationCommand(terminal, environment);
            if (!command) {
                outcome = 'noCommand';
            } else if (terminal.shellIntegration) {
                outcome = await this.executeTerminalShellCommandInternal(terminal.shellIntegration, command);
            } else {
                terminal.sendText(command);
                outcome = 'unverified';
            }
        } catch (error) {
            traceError(`Failed to ${operation} terminal environment`, error);
        }
        if (outcome !== 'succeeded' && outcome !== 'unverified') {
            traceError(`Terminal ${operation} outcome: ${outcome}`);
        }
        sendTelemetryEvent(EventNames.TERMINAL_ACTIVATION_OUTCOME, watch.elapsedTime, {
            operation,
            outcome,
            method,
            shell: identifyTerminalShell(terminal),
            trigger,
        });
        return outcome;
    }

    private async executeTerminalShellCommandInternal(
        shellIntegration: TerminalShellIntegration,
        command: string,
    ): Promise<CommandOutcome> {
        const execution = shellIntegration.executeCommand(command);
        const disposables: Disposable[] = [];
        const timeoutMs = getShellIntegrationTimeout();

        const promise = new Promise<CommandOutcome>((resolve) => {
            const timer = setTimeout(() => {
                resolve('timedOut');
            }, timeoutMs);

            disposables.push(
                new Disposable(() => clearTimeout(timer)),
                this.onTerminalShellExecutionEnd((e: TerminalShellExecutionEndEvent) => {
                    if (e.execution === execution) {
                        resolve(e.exitCode === 0 ? 'succeeded' : e.exitCode === undefined ? 'unknown' : 'failed');
                    }
                }),
                this.onTerminalShellExecutionStart((e: TerminalShellExecutionStartEvent) => {
                    if (e.execution === execution) {
                        traceVerbose(`Shell execution started: ${command}`);
                    }
                }),
            );
        });

        try {
            return await promise;
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    }
}
