import { Disposable, LogOutputChannel, Terminal } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { traceVerbose } from '../../common/logging';
import { onDidEndTerminalShellExecution } from '../../common/window.apis';
import { TerminalEnvironment } from './terminalActivationState';
import { getEnvironmentForTerminal } from './utils';

/**
 * Detects if a terminal command is a package-modifying command that should
 * trigger a package list refresh. This is manager-agnostic - it detects
 * pip, uv, conda, and poetry commands.
 */
export function isPackageModifyingCommand(command: string): boolean {
    // pip install/uninstall (including python -m pip, pip3, uv pip, etc.)
    if (/(?:^|\s)(?:\S+\s+)*(?:pip\d*)\s+(install|uninstall)\b/.test(command)) {
        return true;
    }

    // uv pip install/uninstall
    if (/(?:^|\s)uv\s+pip\s+(install|uninstall)\b/.test(command)) {
        return true;
    }

    // conda install/remove/uninstall
    if (/(?:^|\s)(?:conda|mamba|micromamba)\s+(install|remove|uninstall)\b/.test(command)) {
        return true;
    }

    // poetry add/remove
    if (/(?:^|\s)poetry\s+(add|remove)\b/.test(command)) {
        return true;
    }

    // pipenv install/uninstall
    if (/(?:^|\s)pipenv\s+(install|uninstall)\b/.test(command)) {
        return true;
    }

    return false;
}

/**
 * Gets the environment to use for package refresh in a terminal.
 *
 * Priority order:
 * 1. Terminal's tracked activated environment (from terminalActivation state)
 * 2. Environment based on terminal cwd/workspace heuristics
 *
 * This ensures we use the actual environment activated in the terminal,
 * not just the workspace's selected environment.
 */
export async function getEnvironmentForPackageRefresh(
    terminal: Terminal,
    terminalEnv: TerminalEnvironment,
    api: PythonEnvironmentApi,
): Promise<PythonEnvironment | undefined> {
    // First try to get the environment that's tracked as activated in this terminal
    const activatedEnv = terminalEnv.getEnvironment(terminal);
    if (activatedEnv) {
        traceVerbose(`Using terminal's activated environment: ${activatedEnv.displayName}`);
        return activatedEnv;
    }

    // Fall back to heuristics based on terminal cwd and workspace
    traceVerbose('No activated environment tracked for terminal, using heuristic lookup');
    return getEnvironmentForTerminal(api, terminal);
}

/**
 * Registers a manager-agnostic terminal watcher that listens for package-modifying
 * commands and triggers a refresh on the appropriate package manager for the
 * currently selected environment.
 *
 * This ensures that regardless of what command the user runs (pip, conda, etc.),
 * the refresh is performed using the configured package manager for the workspace's
 * selected environment.
 */
export function registerTerminalPackageWatcher(
    api: PythonEnvironmentApi,
    terminalEnv: TerminalEnvironment,
    log: LogOutputChannel,
    disposables: Disposable[],
): void {
    disposables.push(
        onDidEndTerminalShellExecution(async (e) => {
            const commandLine = e.execution.commandLine.value;
            const terminal = e.terminal;

            if (isPackageModifyingCommand(commandLine)) {
                traceVerbose(`Package-modifying command detected: ${commandLine}`);

                try {
                    // Get the environment for this terminal - prioritizes activated env over workspace selection
                    const env = await getEnvironmentForPackageRefresh(terminal, terminalEnv, api);

                    if (env) {
                        traceVerbose(
                            `Refreshing packages for environment: ${env.displayName} (${env.envId.managerId})`,
                        );
                        // This delegates to the correct package manager based on the environment
                        await api.refreshPackages(env);
                    } else {
                        traceVerbose('No environment found for terminal, skipping package refresh');
                    }
                } catch (error) {
                    log.error(`Error refreshing packages after terminal command: ${error}`);
                }
            }
        }),
    );
}
