import * as cp from 'child_process';
import { PythonEnvironment, PythonBackgroundRunOptions, PythonProcess } from '../../api';

export async function runInBackground(
    environment: PythonEnvironment,
    options: PythonBackgroundRunOptions,
): Promise<PythonProcess> {
    const executable =
        environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable ?? 'python';
    const args = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const allArgs = [...args, ...options.args];

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
