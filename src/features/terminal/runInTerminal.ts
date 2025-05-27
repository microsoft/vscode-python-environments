import { Terminal, TerminalShellExecution } from 'vscode';
import { PythonEnvironment, PythonTerminalExecutionOptions } from '../../api';
import { onDidEndTerminalShellExecution, showErrorMessage } from '../../common/window.apis';
import { createDeferred } from '../../common/utils/deferred';
import { quoteArgs } from '../execution/execUtils';
import { identifyTerminalShell } from '../common/shellDetector';
import { ShellConstants } from '../common/shellConstants';
import { executableExists } from '../../common/utils/executableExists';
import { Common } from '../../common/localize';

export async function runInTerminal(
    environment: PythonEnvironment,
    terminal: Terminal,
    options: PythonTerminalExecutionOptions,
): Promise<void> {
    if (options.show) {
        terminal.show();
    }

    const executable =
        environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable ?? 'python';
    const args = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const allArgs = [...args, ...(options.args ?? [])];

    // Check if the Python executable exists
    if (!(await executableExists(executable))) {
        await showErrorMessage(Common.pythonNotFound, { modal: true }, Common.installPython);
        return;
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
        execution = terminal.shellIntegration.executeCommand(executable, allArgs);
        await deferred.promise;
    } else {
        const shellType = identifyTerminalShell(terminal);
        let text = quoteArgs([executable, ...allArgs]).join(' ');
        if (shellType === ShellConstants.PWSH && !text.startsWith('&')) {
            // PowerShell requires commands to be prefixed with '&' to run them.
            text = `& ${text}`;
        }
        terminal.sendText(`${text}\n`);
    }
}
