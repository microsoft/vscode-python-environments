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

function getLiteralShellCommand(shellType: string, executable: string, args: string[]): string | undefined {
    if (shellType === ShellConstants.PWSH) {
        // PowerShell also treats typographic single quotes as string delimiters.
        return `& ${[executable, ...args].map((arg) => `'${arg.replace(/['\u2018-\u201b]/g, '$&$&')}'`).join(' ')}`;
    }
    return posixShells.has(shellType) ? quote([executable, ...args]) : undefined;
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
    if (!terminal.shellIntegration) {
        await waitForShellIntegrationBeforeRun(terminal);
    }
    const shellType = identifyTerminalShell(terminal);

    // Normalize executable path for Git Bash on Windows
    if (shellType === ShellConstants.GITBASH) {
        executable = normalizeShellPath(executable, shellType);
    }
    const literalCommand = getLiteralShellCommand(shellType, executable, allArgs);
    if (terminal.shellIntegration) {
        let execution: TerminalShellExecution | undefined;
        const deferred = createDeferred<void>();
        const disposable = onDidEndTerminalShellExecution((e) => {
            if (e.execution === execution) {
                disposable.dispose();
                deferred.resolve();
            }
        });

        if (literalCommand !== undefined) {
            execution = terminal.shellIntegration.executeCommand(literalCommand);
            traceLog(`runInTerminal: executeCommand ${literalCommand}`);
        } else {
            const shouldSurroundWithQuotes =
                executable.includes(' ') && !executable.startsWith('"') && !executable.endsWith('"');
            // Handle case where executable contains white-spaces.
            if (shouldSurroundWithQuotes) {
                executable = `"${executable}"`;
            }

            execution = terminal.shellIntegration.executeCommand(executable, allArgs);
            traceLog(`runInTerminal: executeCommand ${executable} ${allArgs.join(' ')}`);
        }
        await deferred.promise;
    } else {
        const text = literalCommand ?? quoteArgs([executable, ...allArgs]).join(' ');
        terminal.sendText(`${text}\n`);
        traceLog(`runInTerminal: sendText ${text}`);
    }
}
