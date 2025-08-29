import { Terminal, TerminalShellExecution } from 'vscode';
import { PythonEnvironment, PythonTerminalExecutionOptions } from '../../api';
import { createDeferred } from '../../common/utils/deferred';
import { onDidEndTerminalShellExecution } from '../../common/window.apis';
import { identifyTerminalShell } from '../common/shellDetector';
import { getShellCommandAsString } from './shells/common/shellUtils';

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
    if (terminal.shellIntegration) {
        let execution: TerminalShellExecution | undefined;
        const deferred = createDeferred<void>();
        const disposable = onDidEndTerminalShellExecution((e) => {
            if (e.execution === execution) {
                disposable.dispose();
                deferred.resolve();
            }
        });

        executable = getShellCommandAsString(shellType, [{ executable }]);
        execution = terminal.shellIntegration.executeCommand(executable, allArgs);
        await deferred.promise;
    } else {
        const text = getShellCommandAsString(shellType, [{ executable, args: allArgs }]);
        terminal.sendText(`${text}\n`);
    }
}
