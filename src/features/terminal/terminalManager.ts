import * as path from 'path';
import * as fsapi from 'fs-extra';
import { Disposable, EventEmitter, ProgressLocation, Terminal, Uri, TerminalOptions } from 'vscode';
import {
    createTerminal,
    onDidCloseTerminal,
    onDidOpenTerminal,
    terminals,
    withProgress,
} from '../../common/window.apis';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject, PythonTerminalCreateOptions } from '../../api';
import { isActivatableEnvironment } from '../common/activation';
import { getConfiguration } from '../../common/workspace.apis';
import { getAutoActivationType, getEnvironmentForTerminal, waitForShellIntegration } from './utils';
import {
    DidChangeTerminalActivationStateEvent,
    TerminalActivation,
    TerminalActivationInternal,
    TerminalEnvironment,
} from './terminalActivationState';
import { getPythonApi } from '../pythonApi';
import { traceInfo, traceVerbose } from '../../common/logging';

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

export interface TerminalInit {
    initialize(api: PythonEnvironmentApi): Promise<void>;
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
    private skipActivationOnOpen = new Set<Terminal>();

    private onTerminalOpenedEmitter = new EventEmitter<Terminal>();
    private onTerminalOpened = this.onTerminalOpenedEmitter.event;

    private onTerminalClosedEmitter = new EventEmitter<Terminal>();
    private onTerminalClosed = this.onTerminalClosedEmitter.event;

    private onDidChangeTerminalActivationStateEmitter = new EventEmitter<DidChangeTerminalActivationStateEvent>();
    public onDidChangeTerminalActivationState = this.onDidChangeTerminalActivationStateEmitter.event;

    constructor(private readonly ta: TerminalActivationInternal) {
        this.disposables.push(
            this.onTerminalOpenedEmitter,
            this.onTerminalClosedEmitter,
            this.onDidChangeTerminalActivationStateEmitter,
            onDidOpenTerminal((t: Terminal) => {
                this.onTerminalOpenedEmitter.fire(t);
            }),
            onDidCloseTerminal((t: Terminal) => {
                this.onTerminalClosedEmitter.fire(t);
            }),
            this.onTerminalOpened(async (t) => {
                if (this.skipActivationOnOpen.has(t) || (t.creationOptions as TerminalOptions)?.hideFromUser) {
                    return;
                }
                let env = this.ta.getEnvironment(t);
                if (!env) {
                    const api = await getPythonApi();
                    env = await getEnvironmentForTerminal(api, t);
                }
                if (env) {
                    await this.autoActivateOnTerminalOpen(t, env);
                }
            }),
            this.onTerminalClosed((t) => {
                this.skipActivationOnOpen.delete(t);
            }),
            this.ta.onDidChangeTerminalActivationState((e) => {
                this.onDidChangeTerminalActivationStateEmitter.fire(e);
            }),
        );
    }

    private async autoActivateOnTerminalOpen(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        const actType = getAutoActivationType();
        if (actType === 'command') {
            if (isActivatableEnvironment(environment)) {
                await withProgress(
                    {
                        location: ProgressLocation.Window,
                        title: `Activating environment: ${environment.environmentPath.fsPath}`,
                    },
                    async () => {
                        await waitForShellIntegration(terminal);
                        await this.activate(terminal, environment);
                    },
                );
            } else {
                traceVerbose(`Environment ${environment.environmentPath.fsPath} is not activatable`);
            }
        } else if (actType === 'off') {
            traceInfo(`"python-envs.terminal.autoActivationType" is set to "${actType}", skipping auto activation`);
        } else if (actType === 'startup') {
            traceInfo(
                `"python-envs.terminal.autoActivationType" is set to "${actType}", terminal should be activated by shell startup script`,
            );
        }
    }

    public async create(environment: PythonEnvironment, options: PythonTerminalCreateOptions): Promise<Terminal> {
        // https://github.com/microsoft/vscode-python-environments/issues/172
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

    public async initialize(api: PythonEnvironmentApi): Promise<void> {
        if (getAutoActivationType() === 'command') {
            await Promise.all(
                terminals().map(async (t) => {
                    this.skipActivationOnOpen.add(t);

                    const env = this.ta.getEnvironment(t) ?? (await getEnvironmentForTerminal(api, t));

                    if (env && isActivatableEnvironment(env)) {
                        await this.activate(t, env);
                    }
                }),
            );
        }
    }

    public getEnvironment(terminal: Terminal): PythonEnvironment | undefined {
        return this.ta.getEnvironment(terminal);
    }

    public activate(terminal: Terminal, environment: PythonEnvironment): Promise<void> {
        return this.ta.activate(terminal, environment);
    }

    public deactivate(terminal: Terminal): Promise<void> {
        return this.ta.deactivate(terminal);
    }

    isActivated(terminal: Terminal, environment?: PythonEnvironment): boolean {
        return this.ta.isActivated(terminal, environment);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
