import * as cp from 'child_process';
import { promisify } from 'util';

const cpExec = promisify(cp.exec);

/**
 * Result of execProcess - contains stdout and stderr as strings.
 */
export interface ExecResult {
    stdout: string;
    stderr: string;
}

/**
 * Executes a command and returns the result as a promise.
 * This function abstracts cp.exec to make it easier to mock in tests.
 *
 * @param command The command to execute (can include arguments).
 * @param options Optional execution options.
 * @returns A promise that resolves with { stdout, stderr } strings.
 */
export async function execProcess(command: string, options?: cp.ExecOptions): Promise<ExecResult> {
    const env = {
        PYTHONUTF8: '1',
        ...(options?.env ?? process.env),
    };
    // Force encoding: 'utf8' to guarantee string output (cp.exec can return Buffers otherwise)
    const result = await cpExec(command, { ...options, env, encoding: 'utf8' });
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

/**
 * Spawns a new process using the specified command and arguments.
 * This function abstracts cp.spawn to make it easier to mock in tests.
 *
 * When stdio: 'pipe' is used, returns ChildProcessWithoutNullStreams.
 * Otherwise returns the standard ChildProcess.
 */

// Overload for stdio: 'pipe' - guarantees non-null streams
export function spawnProcess(
    command: string,
    args: string[],
    options: cp.SpawnOptions & { stdio: 'pipe' },
): cp.ChildProcessWithoutNullStreams;

// Overload for general case
export function spawnProcess(command: string, args: string[], options?: cp.SpawnOptions): cp.ChildProcess;

// Implementation - delegates to cp.spawn to preserve its typing magic
export function spawnProcess(
    command: string,
    args: string[],
    options?: cp.SpawnOptions,
): cp.ChildProcess | cp.ChildProcessWithoutNullStreams {
    // Set PYTHONUTF8=1; user-provided PYTHONUTF8 values take precedence.
    const env = {
        PYTHONUTF8: '1',
        ...(options?.env ?? process.env),
    };
    return cp.spawn(command, args, { ...options, env });
}
