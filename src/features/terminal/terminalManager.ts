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
    terminals,
    withProgress,
} from '../../common/window.apis';
import { IconPath, PythonEnvironment, PythonProject } from '../../api';
import { getActivationCommand, getDeactivationCommand, isActivatableEnvironment } from '../common/activation';
import { showErrorMessage } from '../../common/errors/utils';
import { quoteArgs } from '../execution/execUtils';
import { createDeferred } from '../../common/utils/deferred';
import { traceError, traceVerbose } from '../../common/logging';
import { getConfiguration } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';

function getIconPath(i: IconPath | undefined): IconPath | undefined {
    if (i instanceof Uri) {
        return i.fsPath.endsWith('__icon__.py') ? undefined : i;
    }
    return i;
}

const SHELL_INTEGRATION_TIMEOUT = 500; // 0.5 seconds
const SHELL_INTEGRATION_POLL_INTERVAL = 100; // 0.1 seconds

export interface TerminalActivation {
    isActivated(terminal: Terminal, environment?: PythonEnvironment): boolean;
    activate(terminal: Terminal, environment: PythonEnvironment): Promise<void>;
    deactivate(terminal: Terminal): Promise<void>;
}

export interface TerminalCreation {
    create(
        environment: PythonEnvironment,
        cwd?: string | Uri,
        env?: { [key: string]: string | null | undefined },
    ): Promise<Terminal>;
}

export interface TerminalGetters {
    getProjectTerminal(project: PythonProject, environment: PythonEnvironment, createNew?: boolean): Promise<Terminal>;
    getDedicatedTerminal(
        uri: Uri,
        project: PythonProject,
        environment: PythonEnvironment,
        createNew?: boolean,
    ): Promise<Terminal>;
}

export interface TerminalEnvironment {
    getEnvironment(terminal: Terminal): Promise<PythonEnvironment | undefined>;
}

export interface TerminalInit {
    initialize(projects: PythonProject[], em: EnvironmentManagers): Promise<void>;
}

export interface TerminalManager
    extends TerminalEnvironment,
        TerminalInit,
        TerminalActivation,
        TerminalCreation,
        TerminalGetters,
        Disposable {}

export class TerminalManagerImpl implements TerminalManager {
    private disposables: Disposable[] = [];
    private activatedTerminals = new Map<Terminal, PythonEnvironment>();
    private activatingTerminals = new Map<Terminal, Promise<void>>();
    private deactivatingTerminals = new Map<Terminal, Promise<void>>();

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
            this.activatedTerminals.set(terminal, environment);
        }
    }

    private deactivateLegacy(terminal: Terminal, environment: PythonEnvironment) {
        const deactivationCommands = getDeactivationCommand(terminal, environment);
        if (deactivationCommands) {
            for (const command of deactivationCommands) {
                const args = command.args ?? [];
                const text = quoteArgs([command.executable, ...args]).join(' ');
                terminal.sendText(text);
            }
            this.activatedTerminals.delete(terminal);
        }
    }

    private async activateUsingShellIntegration(
        shellIntegration: TerminalShellIntegration,
        terminal: Terminal,
        environment: PythonEnvironment,
    ): Promise<void> {
        const activationCommands = getActivationCommand(terminal, environment);
        if (activationCommands) {
            try {
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
                                traceVerbose(
                                    `Shell execution started: ${command.executable} ${command.args?.join(' ')}`,
                                );
                            }
                        }),
                    );
                    await execPromise.promise;
                }
            } finally {
                this.activatedTerminals.set(terminal, environment);
            }
        }
    }

    private async deactivateUsingShellIntegration(
        shellIntegration: TerminalShellIntegration,
        terminal: Terminal,
        environment: PythonEnvironment,
    ): Promise<void> {
        const deactivationCommands = getDeactivationCommand(terminal, environment);
        if (deactivationCommands) {
            try {
                for (const command of deactivationCommands) {
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
                                traceVerbose(
                                    `Shell execution started: ${command.executable} ${command.args?.join(' ')}`,
                                );
                            }
                        }),
                    );

                    await execPromise.promise;
                }
            } finally {
                this.activatedTerminals.delete(terminal);
            }
        }
    }

    private async activateEnvironmentOnCreation(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        const deferred = createDeferred<void>();
        const disposables: Disposable[] = [];
        let disposeTimer: Disposable | undefined;
        let activated = false;
        this.activatingTerminals.set(terminal, deferred.promise);

        try {
            disposables.push(
                new Disposable(() => {
                    this.activatingTerminals.delete(terminal);
                }),
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
            await deferred.promise;
        } catch (ex) {
            traceError('Failed to activate environment:\r\n', ex);
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    }

    public async create(
        environment: PythonEnvironment,
        cwd?: string | Uri | undefined,
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

    public isActivated(terminal: Terminal, environment?: PythonEnvironment): boolean {
        if (!environment) {
            return this.activatedTerminals.has(terminal);
        }
        const env = this.activatedTerminals.get(terminal);
        return env?.envId.id === environment?.envId.id;
    }

    private async activateInternal(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        if (terminal.shellIntegration) {
            await this.activateUsingShellIntegration(terminal.shellIntegration, terminal, environment);
        } else {
            this.activateLegacy(terminal, environment);
        }
    }

    public async activate(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        if (this.isActivated(terminal, environment)) {
            return;
        }

        if (this.deactivatingTerminals.has(terminal)) {
            traceVerbose('Terminal is being deactivated, cannot activate. Waiting...');
            return this.deactivatingTerminals.get(terminal);
        }

        if (this.activatingTerminals.has(terminal)) {
            return this.activatingTerminals.get(terminal);
        }

        try {
            traceVerbose(`Activating terminal for environment: ${environment.displayName}`);
            const promise = this.activateInternal(terminal, environment);
            this.activatingTerminals.set(terminal, promise);
            await promise;
        } catch (ex) {
            traceError('Failed to activate environment:\r\n', ex);
        } finally {
            this.activatingTerminals.delete(terminal);
        }
    }

    private async deactivateInternal(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        if (terminal.shellIntegration) {
            await this.deactivateUsingShellIntegration(terminal.shellIntegration, terminal, environment);
        } else {
            this.deactivateLegacy(terminal, environment);
        }
    }

    public async deactivate(terminal: Terminal): Promise<void> {
        if (this.activatingTerminals.has(terminal)) {
            traceVerbose('Terminal is being activated, cannot deactivate. Waiting...');
            await this.activatingTerminals.get(terminal);
        }

        if (this.deactivatingTerminals.has(terminal)) {
            return this.deactivatingTerminals.get(terminal);
        }

        const environment = this.activatedTerminals.get(terminal);
        if (!environment) {
            return;
        }

        try {
            traceVerbose(`Deactivating terminal for environment: ${environment.displayName}`);
            const promise = this.deactivateInternal(terminal, environment);
            this.deactivatingTerminals.set(terminal, promise);
            await promise;
        } catch (ex) {
            traceError('Failed to deactivate environment:\r\n', ex);
        } finally {
            this.deactivatingTerminals.delete(terminal);
        }
    }

    public async initialize(projects: PythonProject[], em: EnvironmentManagers): Promise<void> {
        const config = getConfiguration('python');
        if (config.get<boolean>('terminal.activateEnvInCurrentTerminal', false)) {
            await Promise.all(
                terminals().map(async (t) => {
                    if (projects.length === 0) {
                        const manager = em.getEnvironmentManager(undefined);
                        const env = await manager?.get(undefined);
                        if (env) {
                            return this.activate(t, env);
                        }
                    } else if (projects.length === 1) {
                        const manager = em.getEnvironmentManager(projects[0].uri);
                        const env = await manager?.get(projects[0].uri);
                        if (env) {
                            return this.activate(t, env);
                        }
                    } else {
                        // TODO: handle multi project case
                    }
                }),
            );
        }
    }

    public async getEnvironment(terminal: Terminal): Promise<PythonEnvironment | undefined> {
        if (this.deactivatingTerminals.has(terminal)) {
            return undefined;
        }

        if (this.activatingTerminals.has(terminal)) {
            await this.activatingTerminals.get(terminal);
        }

        if (this.activatedTerminals.has(terminal)) {
            return Promise.resolve(this.activatedTerminals.get(terminal));
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
