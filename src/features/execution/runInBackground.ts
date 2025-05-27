import * as cp from 'child_process';
import { PythonEnvironment, PythonBackgroundRunOptions, PythonProcess } from '../../api';
import { showErrorMessage } from '../../common/window.apis';
import { executableExists } from '../../common/utils/executableExists';
import { Common } from '../../common/localize';

export async function runInBackground(
    environment: PythonEnvironment,
    options: PythonBackgroundRunOptions,
): Promise<PythonProcess> {
    const executable =
        environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable ?? 'python';
    const args = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const allArgs = [...args, ...options.args];

    // Check if the Python executable exists
    if (!(await executableExists(executable))) {
        await showErrorMessage(Common.pythonNotFound, { modal: true }, Common.installPython);
        throw new Error(Common.pythonNotFound);
    }

    const proc = cp.spawn(executable, allArgs, { stdio: 'pipe', cwd: options.cwd, env: options.env });

    return {
        pid: proc.pid,
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: () => {
            if (!proc.killed) {
                proc.kill();
            }
        },
        onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
            proc.on('exit', listener);
        },
    };
}
