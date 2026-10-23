import { Terminal, TerminalShellExecution } from 'vscode';
import quote from 'shell-quote/quote';
import { PythonEnvironment, PythonTerminalExecutionOptions } from '../../api';
import { createDeferred } from '../../common/utils/deferred';
import { onDidEndTerminalShellExecution } from '../../common/window.apis';
import { ShellConstants } from '../common/shellConstants';
import { identifyTerminalShell } from '../common/shellDetector';
import { quoteArgs } from '../execution/execUtils';
import { normalizeShellPath } from './shells/common/shellUtils';
import { traceLog } from '../../common/logging';
import { SHELL_INTEGRATION_TIMEOUT, waitForShellIntegration } from './utils';

const shellIntegrationWaits = new WeakMap<Terminal, Promise<boolean>>();
const posixShells = new Set([
    ShellConstants.SH,
    ShellConstants.BASH,
    ShellConstants.ZSH,
    ShellConstants.KSH,
    ShellConstants.GITBASH,
]);

async function waitForShellIntegrationBeforeRun(terminal: Terminal): Promise<void> {
    let waitPromise = shellIntegrationWaits.get(terminal);
    if (!waitPromise) {
        waitPromise = waitForShellIntegration(terminal, SHELL_INTEGRATION_TIMEOUT);
        shellIntegrationWaits.set(terminal, waitPromise);
    }
    await waitPromise;
}

function getCommandLine(shellType: string, executable: string, args: string[]): string {
    let command = posixShells.has(shellType)
        ? quote([executable, ...args])
        : quoteArgs([executable, ...args]).join(' ');

    if (shellType === ShellConstants.PWSH && !command.startsWith('&')) {
        command = `& ${command}`;
    }
    return command;
}

function getShellIntegrationExecutable(shellType: string, executable: string): string {
    let command = executable;
    if (command.includes(' ') && !command.startsWith('"') && !command.endsWith('"')) {
        command = `"${command}"`;
    }
    if (shellType === ShellConstants.PWSH && !command.startsWith('&')) {
        command = `& ${command}`;
    }
    return command;
}

export async function runInTerminal(
    environment: PythonEnvironment,
    terminal: Terminal,
    options: PythonTerminalExecutionOptions,
): Promise<void> {
    if (options.show) {
        terminal.show();
    }

    let executable = environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable ?? 'python';
    const args = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const allArgs = [...args, ...(options.args ?? [])];
    const shellType = identifyTerminalShell(terminal);

    // Normalize executable path for Git Bash on Windows
    if (shellType === ShellConstants.GITBASH) {
        executable = normalizeShellPath(executable, shellType);
    }
    if (!terminal.shellIntegration) {
        await waitForShellIntegrationBeforeRun(terminal);
    }
    if (terminal.shellIntegration) {
        let execution: TerminalShellExecution | undefined;
        const deferred = createDeferred<void>();
        const disposable = onDidEndTerminalShellExecution((e) => {
            if (e.execution === execution) {
                disposable.dispose();
                deferred.resolve();
            }
        });

        if (posixShells.has(shellType)) {
            const commandLine = getCommandLine(shellType, executable, allArgs);
            execution = terminal.shellIntegration.executeCommand(commandLine);
            traceLog(`runInTerminal: executeCommand ${commandLine}`);
        } else {
            const shellExecutable = getShellIntegrationExecutable(shellType, executable);
            execution = terminal.shellIntegration.executeCommand(shellExecutable, allArgs);
            traceLog(`runInTerminal: executeCommand ${shellExecutable} ${allArgs.join(' ')}`);
        }
        await deferred.promise;
    } else {
        const text = getCommandLine(shellType, executable, allArgs);
        terminal.sendText(`${text}\n`);
        traceLog(`runInTerminal: sendText ${text}`);
    }
}
