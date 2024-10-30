import * as path from 'path';
import * as fsapi from 'fs-extra';
import {
    Disposable,
    EventEmitter,
    ProgressLocation,
    TerminalShellIntegration,
    Terminal,
    TerminalShellExecutionEndEvent,
    TerminalShellExecutionStartEvent,
    TerminalShellIntegrationChangeEvent,
    Uri,
} from 'vscode';
import {
    createTerminal,
    onDidChangeTerminalShellIntegration,
    onDidCloseTerminal,
    onDidEndTerminalShellExecution,
    onDidOpenTerminal,
    onDidStartTerminalShellExecution,
    withProgress,
} from '../../common/window.apis';
import { IconPath, PythonEnvironment, PythonProject } from '../../api';
import { getActivationCommand, isActivatableEnvironment } from './activation';
import { showErrorMessage } from '../../common/errors/utils';
import { quoteArgs } from './execUtils';
import { createDeferred } from '../../common/utils/deferred';
import { traceVerbose } from '../../common/logging';
import { getConfiguration } from '../../common/workspace.apis';

function getIconPath(i: IconPath | undefined): IconPath | undefined {
    if (i instanceof Uri) {
        return i.fsPath.endsWith('__icon__.py') ? undefined : i;
    }
    return i;
}

const SHELL_INTEGRATION_TIMEOUT = 500; // 0.5 seconds
const SHELL_INTEGRATION_POLL_INTERVAL = 100; // 0.1 seconds

export interface TerminalManager extends Disposable {
    getProjectTerminal(project: PythonProject, environment: PythonEnvironment, createNew?: boolean): Promise<Terminal>;
    getDedicatedTerminal(
        uri: Uri,
        project: PythonProject,
        environment: PythonEnvironment,
        createNew?: boolean,
    ): Promise<Terminal>;
    create(
        environment: PythonEnvironment,
        cwd?: string | Uri | PythonProject,
        env?: { [key: string]: string | null | undefined },
    ): Promise<Terminal>;
}

export class TerminalManagerImpl implements Disposable {
    private disposables: Disposable[] = [];
    private onTerminalOpenedEmitter = new EventEmitter<Terminal>();
    private onTerminalOpened = this.onTerminalOpenedEmitter.event;

    private onTerminalClosedEmitter = new EventEmitter<Terminal>();
    private onTerminalClosed = this.onTerminalClosedEmitter.event;

    private onTerminalShellIntegrationChangedEmitter = new EventEmitter<TerminalShellIntegrationChangeEvent>();
    private onTerminalShellIntegrationChanged = this.onTerminalShellIntegrationChangedEmitter.event;

    private onTerminalShellExecutionStartEmitter = new EventEmitter<TerminalShellExecutionStartEvent>();
    private onTerminalShellExecutionStart = this.onTerminalShellExecutionStartEmitter.event;

    private onTerminalShellExecutionEndEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();
    private onTerminalShellExecutionEnd = this.onTerminalShellExecutionEndEmitter.event;

    constructor() {
        this.disposables.push(
            onDidOpenTerminal((t: Terminal) => {
                this.onTerminalOpenedEmitter.fire(t);
            }),
            onDidCloseTerminal((t: Terminal) => {
                this.onTerminalClosedEmitter.fire(t);
            }),
            onDidChangeTerminalShellIntegration((e: TerminalShellIntegrationChangeEvent) => {
                this.onTerminalShellIntegrationChangedEmitter.fire(e);
            }),
            onDidStartTerminalShellExecution((e: TerminalShellExecutionStartEvent) => {
                this.onTerminalShellExecutionStartEmitter.fire(e);
            }),
            onDidEndTerminalShellExecution((e: TerminalShellExecutionEndEvent) => {
                this.onTerminalShellExecutionEndEmitter.fire(e);
            }),
            this.onTerminalOpenedEmitter,
            this.onTerminalClosedEmitter,
            this.onTerminalShellIntegrationChangedEmitter,
            this.onTerminalShellExecutionStartEmitter,
            this.onTerminalShellExecutionEndEmitter,
        );
    }

    private activateLegacy(terminal: Terminal, environment: PythonEnvironment) {
        const activationCommands = getActivationCommand(terminal, environment);
        if (activationCommands) {
            for (const command of activationCommands) {
                const args = command.args ?? [];
                const text = quoteArgs([command.executable, ...args]).join(' ');
                terminal.sendText(text);
            }
        }
    }

    private async activateUsingShellIntegration(
        shellIntegration: TerminalShellIntegration,
        terminal: Terminal,
        environment: PythonEnvironment,
    ): Promise<void> {
        const activationCommands = getActivationCommand(terminal, environment);
        if (activationCommands) {
            for (const command of activationCommands) {
                const execPromise = createDeferred<void>();
                const execution = shellIntegration.executeCommand(command.executable, command.args ?? []);
                const disposables: Disposable[] = [];
                disposables.push(
                    this.onTerminalShellExecutionEnd((e: TerminalShellExecutionEndEvent) => {
                        if (e.execution === execution) {
                            execPromise.resolve();
                        }
                    }),
                    this.onTerminalShellExecutionStart((e: TerminalShellExecutionStartEvent) => {
                        if (e.execution === execution) {
                            traceVerbose(`Shell execution started: ${command.executable} ${command.args?.join(' ')}`);
                        }
                    }),
                );

                await execPromise.promise;
            }
        }
    }

    private async activateEnvironmentOnCreation(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        const deferred = createDeferred<void>();
        const disposables: Disposable[] = [];
        let disposeTimer: Disposable | undefined;
        let activated = false;

        try {
            disposables.push(
                this.onTerminalOpened(async (t: Terminal) => {
                    if (t === terminal) {
                        if (terminal.shellIntegration) {
                            // Shell integration is available when the terminal is opened.
                            activated = true;
                            await this.activateUsingShellIntegration(terminal.shellIntegration, terminal, environment);
                            deferred.resolve();
                        } else {
                            let seconds = 0;
                            const timer = setInterval(() => {
                                seconds += SHELL_INTEGRATION_POLL_INTERVAL;
                                if (terminal.shellIntegration || activated) {
                                    disposeTimer?.dispose();
                                    return;
                                }

                                if (seconds >= SHELL_INTEGRATION_TIMEOUT) {
                                    disposeTimer?.dispose();
                                    activated = true;
                                    this.activateLegacy(terminal, environment);
                                    deferred.resolve();
                                }
                            }, 100);

                            disposeTimer = new Disposable(() => {
                                clearInterval(timer);
                                disposeTimer = undefined;
                            });
                        }
                    }
                }),
                this.onTerminalShellIntegrationChanged(async (e: TerminalShellIntegrationChangeEvent) => {
                    if (terminal === e.terminal && !activated) {
                        disposeTimer?.dispose();
                        activated = true;
                        await this.activateUsingShellIntegration(e.shellIntegration, terminal, environment);
                        deferred.resolve();
                    }
                }),
                this.onTerminalClosed((t) => {
                    if (terminal === t && !deferred.completed) {
                        deferred.reject(new Error('Terminal closed before activation'));
                    }
                }),
                new Disposable(() => {
                    disposeTimer?.dispose();
                }),
            );
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    }

    public async create(
        environment: PythonEnvironment,
        cwd?: string | Uri,
        env?: { [key: string]: string | null | undefined },
    ): Promise<Terminal> {
        const activatable = isActivatableEnvironment(environment);
        const newTerminal = createTerminal({
            // name: `Python: ${environment.displayName}`,
            iconPath: getIconPath(environment.iconPath),
            cwd,
            env,
        });
        if (activatable) {
            try {
                await withProgress(
                    {
                        location: ProgressLocation.Window,
                        title: `Activating ${environment.displayName}`,
                    },
                    async () => {
                        await this.activateEnvironmentOnCreation(newTerminal, environment);
                    },
                );
            } catch (e) {
                showErrorMessage(`Failed to activate ${environment.displayName}`);
            }
        }
        return newTerminal;
    }

    private dedicatedTerminals = new Map<string, Terminal>();
    async getDedicatedTerminal(
        uri: Uri,
        project: PythonProject,
        environment: PythonEnvironment,
        createNew: boolean = false,
    ): Promise<Terminal> {
        const key = `${environment.envId.id}:${path.normalize(uri.fsPath)}`;
        if (!createNew) {
            const terminal = this.dedicatedTerminals.get(key);
            if (terminal) {
                return terminal;
            }
        }

        const config = getConfiguration('python', uri);
        const projectStat = await fsapi.stat(project.uri.fsPath);
        const projectDir = projectStat.isDirectory() ? project.uri.fsPath : path.dirname(project.uri.fsPath);

        const uriStat = await fsapi.stat(uri.fsPath);
        const uriDir = uriStat.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
        const cwd = config.get<boolean>('terminal.executeInFileDir', false) ? uriDir : projectDir;

        const newTerminal = await this.create(environment, cwd);
        this.dedicatedTerminals.set(key, newTerminal);

        const disable = onDidCloseTerminal((terminal) => {
            if (terminal === newTerminal) {
                this.dedicatedTerminals.delete(key);
                disable.dispose();
            }
        });

        return newTerminal;
    }

    private projectTerminals = new Map<string, Terminal>();
    async getProjectTerminal(
        project: PythonProject,
        environment: PythonEnvironment,
        createNew: boolean = false,
    ): Promise<Terminal> {
        const key = `${environment.envId.id}:${path.normalize(project.uri.fsPath)}`;
        if (!createNew) {
            const terminal = this.projectTerminals.get(key);
            if (terminal) {
                return terminal;
            }
        }
        const stat = await fsapi.stat(project.uri.fsPath);
        const cwd = stat.isDirectory() ? project.uri.fsPath : path.dirname(project.uri.fsPath);
        const newTerminal = await this.create(environment, cwd);
        this.projectTerminals.set(key, newTerminal);

        const disable = onDidCloseTerminal((terminal) => {
            if (terminal === newTerminal) {
                this.projectTerminals.delete(key);
                disable.dispose();
            }
        });

        return newTerminal;
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
