import {
    Disposable,
    Progress,
    ProgressLocation,
    Terminal,
    TerminalShellExecutionEndEvent,
    TerminalShellIntegration,
    Uri,
} from 'vscode';
import { IconPath, PythonEnvironment, PythonProject } from '../../api';
import * as path from 'path';
import * as fsapi from 'fs-extra';
import {
    createTerminal,
    onDidChangeTerminalShellIntegration,
    onDidCloseTerminal,
    onDidEndTerminalShellExecution,
    onDidOpenTerminal,
    withProgress,
} from '../../common/window.apis';
import { getActivationCommand, isActivatableEnvironment } from './activation';
import { createDeferred } from '../../common/utils/deferred';
import { getConfiguration } from '../../common/workspace.apis';
import { quoteArgs } from './execUtils';
import { showErrorMessage } from '../../common/errors/utils';

const SHELL_INTEGRATION_TIMEOUT = 5;

async function runActivationCommands(
    shellIntegration: TerminalShellIntegration,
    terminal: Terminal,
    environment: PythonEnvironment,
    progress: Progress<{
        message?: string;
        increment?: number;
    }>,
) {
    const activationCommands = getActivationCommand(terminal, environment);
    if (activationCommands) {
        for (const command of activationCommands) {
            const text = command.args ? `${command.executable} ${command.args.join(' ')}` : command.executable;
            progress.report({ message: `Activating ${environment.displayName}: running ${text}` });
            const execPromise = createDeferred<void>();
            const execution = command.args
                ? shellIntegration.executeCommand(command.executable, command.args)
                : shellIntegration.executeCommand(command.executable);

            const disposable = onDidEndTerminalShellExecution((e: TerminalShellExecutionEndEvent) => {
                if (e.execution === execution) {
                    execPromise.resolve();
                    disposable.dispose();
                }
            });

            await execPromise.promise;
        }
    }
}

function runActivationCommandsLegacy(terminal: Terminal, environment: PythonEnvironment) {
    const activationCommands = getActivationCommand(terminal, environment);
    if (activationCommands) {
        for (const command of activationCommands) {
            const args = command.args ?? [];
            const text = quoteArgs([command.executable, ...args]).join(' ');
            terminal.sendText(text);
        }
    }
}

async function activateEnvironmentOnCreation(
    newTerminal: Terminal,
    environment: PythonEnvironment,
    progress: Progress<{
        message?: string;
        increment?: number;
    }>,
) {
    const deferred = createDeferred<void>();
    const disposables: Disposable[] = [];
    let disposeTimer: Disposable | undefined;

    try {
        let activated = false;
        progress.report({ message: `Activating ${environment.displayName}: waiting for Shell Integration` });
        disposables.push(
            onDidChangeTerminalShellIntegration(async ({ terminal, shellIntegration }) => {
                if (terminal === newTerminal && !activated) {
                    disposeTimer?.dispose();
                    activated = true;
                    await runActivationCommands(shellIntegration, terminal, environment, progress);
                    deferred.resolve();
                }
            }),
            onDidOpenTerminal((terminal) => {
                if (terminal === newTerminal) {
                    let seconds = 0;
                    const timer = setInterval(() => {
                        if (newTerminal.shellIntegration || activated) {
                            return;
                        }
                        if (seconds >= SHELL_INTEGRATION_TIMEOUT) {
                            disposeTimer?.dispose();
                            activated = true;
                            progress.report({ message: `Activating ${environment.displayName}: using legacy method` });
                            runActivationCommandsLegacy(terminal, environment);
                            deferred.resolve();
                        } else {
                            progress.report({
                                message: `Activating ${environment.displayName}: waiting for Shell Integration ${
                                    SHELL_INTEGRATION_TIMEOUT - seconds
                                }s`,
                            });
                        }
                        seconds++;
                    }, 1000);

                    disposeTimer = new Disposable(() => {
                        clearInterval(timer);
                        disposeTimer = undefined;
                    });
                }
            }),
            onDidCloseTerminal((terminal) => {
                if (terminal === newTerminal && !deferred.completed) {
                    deferred.reject(new Error('Terminal closed before activation'));
                }
            }),
            new Disposable(() => {
                disposeTimer?.dispose();
            }),
        );
        await deferred.promise;
    } finally {
        disposables.forEach((d) => d.dispose());
    }
}

function getIconPath(i: IconPath | undefined): IconPath | undefined {
    if (i instanceof Uri) {
        return i.fsPath.endsWith('__icon__.py') ? undefined : i;
    }
    return i;
}

export async function createPythonTerminal(environment: PythonEnvironment, cwd?: string | Uri): Promise<Terminal> {
    const activatable = isActivatableEnvironment(environment);
    const newTerminal = createTerminal({
        // name: `Python: ${environment.displayName}`,
        iconPath: getIconPath(environment.iconPath),
        cwd,
    });

    if (activatable) {
        try {
            await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: `Activating ${environment.displayName}`,
                },
                async (progress) => {
                    await activateEnvironmentOnCreation(newTerminal, environment, progress);
                },
            );
        } catch (e) {
            showErrorMessage(`Failed to activate ${environment.displayName}`);
        }
    }

    return newTerminal;
}

const dedicatedTerminals = new Map<string, Terminal>();
export async function getDedicatedTerminal(
    uri: Uri,
    environment: PythonEnvironment,
    project: PythonProject,
    createNew: boolean = false,
): Promise<Terminal> {
    const key = `${environment.envId.id}:${path.normalize(uri.fsPath)}`;
    if (!createNew) {
        const terminal = dedicatedTerminals.get(key);
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

    const newTerminal = await createPythonTerminal(environment, cwd);
    dedicatedTerminals.set(key, newTerminal);

    const disable = onDidCloseTerminal((terminal) => {
        if (terminal === newTerminal) {
            dedicatedTerminals.delete(key);
            disable.dispose();
        }
    });

    return newTerminal;
}

const projectTerminals = new Map<string, Terminal>();
export async function getProjectTerminal(
    project: PythonProject,
    environment: PythonEnvironment,
    createNew: boolean = false,
): Promise<Terminal | undefined> {
    const key = `${environment.envId.id}:${path.normalize(project.uri.fsPath)}`;
    if (!createNew) {
        const terminal = projectTerminals.get(key);
        if (terminal) {
            return terminal;
        }
    }
    const stat = await fsapi.stat(project.uri.fsPath);
    const cwd = stat.isDirectory() ? project.uri.fsPath : path.dirname(project.uri.fsPath);
    const newTerminal = await createPythonTerminal(environment, cwd);
    projectTerminals.set(key, newTerminal);

    const disable = onDidCloseTerminal((terminal) => {
        if (terminal === newTerminal) {
            projectTerminals.delete(key);
            disable.dispose();
        }
    });

    return newTerminal;
}
