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
    Uri,
    TerminalOptions,
} from 'vscode';
import {
    createTerminal,
    onDidCloseTerminal,
    onDidEndTerminalShellExecution,
    onDidOpenTerminal,
    onDidStartTerminalShellExecution,
    terminals,
    withProgress,
} from '../../common/window.apis';
import { PythonEnvironment, PythonProject, PythonTerminalCreateOptions } from '../../api';
import { getActivationCommand, getDeactivationCommand, isActivatableEnvironment } from '../common/activation';
import { quoteArgs } from '../execution/execUtils';
import { createDeferred } from '../../common/utils/deferred';
import { traceError, traceVerbose } from '../../common/logging';
import { getConfiguration } from '../../common/workspace.apis';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { waitForShellIntegration } from './utils';

export interface TerminalActivation {
    isActivated(terminal: Terminal, environment?: PythonEnvironment): boolean;
    activate(terminal: Terminal, environment: PythonEnvironment): Promise<void>;
    deactivate(terminal: Terminal): Promise<void>;
}

export interface TerminalCreation {
    create(environment: PythonEnvironment, options: PythonTerminalCreateOptions): Promise<Terminal>;
}

export interface TerminalGetters {
    getProjectTerminal(
        project: Uri | PythonProject,
        environment: PythonEnvironment,
        createNew?: boolean,
    ): Promise<Terminal>;
    getDedicatedTerminal(
        terminalKey: Uri | string,
        project: Uri | PythonProject,
        environment: PythonEnvironment,
        createNew?: boolean,
    ): Promise<Terminal>;
}

export interface TerminalEnvironment {
    getEnvironment(terminal: Terminal): Promise<PythonEnvironment | undefined>;
}

export interface TerminalInit {
    initialize(): Promise<void>;
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
    private skipActivationOnOpen = new Set<Terminal>();

    private onTerminalOpenedEmitter = new EventEmitter<Terminal>();
    private onTerminalOpened = this.onTerminalOpenedEmitter.event;

    private onTerminalClosedEmitter = new EventEmitter<Terminal>();
    private onTerminalClosed = this.onTerminalClosedEmitter.event;

    private onTerminalShellExecutionStartEmitter = new EventEmitter<TerminalShellExecutionStartEvent>();
    private onTerminalShellExecutionStart = this.onTerminalShellExecutionStartEmitter.event;

    private onTerminalShellExecutionEndEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();
    private onTerminalShellExecutionEnd = this.onTerminalShellExecutionEndEmitter.event;

    constructor(private readonly projectManager: PythonProjectManager, private readonly em: EnvironmentManagers) {
        this.disposables.push(
            onDidOpenTerminal((t: Terminal) => {
                this.onTerminalOpenedEmitter.fire(t);
            }),
            onDidCloseTerminal((t: Terminal) => {
                this.onTerminalClosedEmitter.fire(t);
            }),
            onDidStartTerminalShellExecution((e: TerminalShellExecutionStartEvent) => {
                this.onTerminalShellExecutionStartEmitter.fire(e);
            }),
            onDidEndTerminalShellExecution((e: TerminalShellExecutionEndEvent) => {
                this.onTerminalShellExecutionEndEmitter.fire(e);
            }),
            this.onTerminalOpenedEmitter,
            this.onTerminalClosedEmitter,
            this.onTerminalShellExecutionStartEmitter,
            this.onTerminalShellExecutionEndEmitter,
            this.onTerminalOpened(async (t) => {
                if (this.skipActivationOnOpen.has(t) || (t.creationOptions as TerminalOptions)?.hideFromUser) {
                    return;
                }
                await this.autoActivateOnTerminalOpen(t);
            }),
            this.onTerminalClosed((t) => {
                this.activatedTerminals.delete(t);
                this.activatingTerminals.delete(t);
                this.deactivatingTerminals.delete(t);
                this.skipActivationOnOpen.delete(t);
            }),
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

    private async getActivationEnvironment(): Promise<PythonEnvironment | undefined> {
        const projects = this.projectManager.getProjects();
        const uri = projects.length === 0 ? undefined : projects[0].uri;
        const manager = this.em.getEnvironmentManager(uri);
        const env = await manager?.get(uri);
        return env;
    }

    private async autoActivateOnTerminalOpen(terminal: Terminal, environment?: PythonEnvironment): Promise<void> {
        const config = getConfiguration('python');
        if (!config.get<boolean>('terminal.activateEnvironment', false)) {
            return;
        }

        const env = environment ?? (await this.getActivationEnvironment());
        if (env && isActivatableEnvironment(env)) {
            await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: `Activating environment: ${env.displayName}`,
                },
                async () => {
                    await waitForShellIntegration(terminal);
                    await this.activate(terminal, env);
                },
            );
        }
    }

    public async create(environment: PythonEnvironment, options: PythonTerminalCreateOptions): Promise<Terminal> {
        // const name = options.name ?? `Python: ${environment.displayName}`;
        const newTerminal = createTerminal({
            name: options.name,
            shellPath: options.shellPath,
            shellArgs: options.shellArgs,
            cwd: options.cwd,
            env: options.env,
            strictEnv: options.strictEnv,
            message: options.message,
            iconPath: options.iconPath,
            hideFromUser: options.hideFromUser,
            color: options.color,
            location: options.location,
            isTransient: options.isTransient,
        });

        if (options.disableActivation) {
            this.skipActivationOnOpen.add(newTerminal);
            return newTerminal;
        }

        // We add it to skip activation on open to prevent double activation.
        // We can activate it ourselves since we are creating it.
        this.skipActivationOnOpen.add(newTerminal);
        await this.autoActivateOnTerminalOpen(newTerminal, environment);

        return newTerminal;
    }

    private dedicatedTerminals = new Map<string, Terminal>();
    async getDedicatedTerminal(
        terminalKey: Uri,
        project: Uri | PythonProject,
        environment: PythonEnvironment,
        createNew: boolean = false,
    ): Promise<Terminal> {
        const part = terminalKey instanceof Uri ? path.normalize(terminalKey.fsPath) : terminalKey;
        const key = `${environment.envId.id}:${part}`;
        if (!createNew) {
            const terminal = this.dedicatedTerminals.get(key);
            if (terminal) {
                return terminal;
            }
        }

        const puri = project instanceof Uri ? project : project.uri;
        const config = getConfiguration('python', terminalKey);
        const projectStat = await fsapi.stat(puri.fsPath);
        const projectDir = projectStat.isDirectory() ? puri.fsPath : path.dirname(puri.fsPath);

        const uriStat = await fsapi.stat(terminalKey.fsPath);
        const uriDir = uriStat.isDirectory() ? terminalKey.fsPath : path.dirname(terminalKey.fsPath);
        const cwd = config.get<boolean>('terminal.executeInFileDir', false) ? uriDir : projectDir;

        const newTerminal = await this.create(environment, { cwd });
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
        project: Uri | PythonProject,
        environment: PythonEnvironment,
        createNew: boolean = false,
    ): Promise<Terminal> {
        const uri = project instanceof Uri ? project : project.uri;
        const key = `${environment.envId.id}:${path.normalize(uri.fsPath)}`;
        if (!createNew) {
            const terminal = this.projectTerminals.get(key);
            if (terminal) {
                return terminal;
            }
        }
        const stat = await fsapi.stat(uri.fsPath);
        const cwd = stat.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
        const newTerminal = await this.create(environment, { cwd });
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

    public async initialize(): Promise<void> {
        const config = getConfiguration('python');
        if (config.get<boolean>('terminal.activateEnvInCurrentTerminal', false)) {
            await Promise.all(
                terminals().map(async (t) => {
                    this.skipActivationOnOpen.add(t);
                    const env = await this.getActivationEnvironment();
                    if (env && isActivatableEnvironment(env)) {
                        await this.activate(t, env);
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
