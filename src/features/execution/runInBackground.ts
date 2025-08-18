import * as cp from 'child_process';
import { PythonBackgroundRunOptions, PythonEnvironment, PythonProcess } from '../../api';
import { traceError, traceInfo } from '../../common/logging';

export async function runInBackground(
    environment: PythonEnvironment,
    options: PythonBackgroundRunOptions,
): Promise<PythonProcess> {
    const executable =
        environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable ?? 'python';
    const args = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const allArgs = [...args, ...options.args];
    traceInfo(`Running in background: ${executable} ${allArgs.join(' ')}`);

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
        onExit: (listener: (code: number | null, signal: NodeJS.Signals | null, error?: Error | null) => void) => {
            proc.on('exit', (code, signal) => {
                if (code && code !== 0) {
                    traceError(`Process exited with error code: ${code}, signal: ${signal}`);
                }
                listener(code, signal, null);
            });
            proc.on('error', (error) => {
                traceError(`Process error: ${error?.message || error}${error?.stack ? '\n' + error.stack : ''}`);
                listener(null, null, error);
            });
        },
    };
}
