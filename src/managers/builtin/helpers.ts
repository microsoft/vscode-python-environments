import * as path from 'path';
import { CancellationError, CancellationToken, LogOutputChannel, Uri } from 'vscode';
import { spawnProcess } from '../../common/childProcess.apis';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred } from '../../common/utils/deferred';
import { getConfiguration, getWorkspaceFolder, isWorkspaceTrusted } from '../../common/workspace.apis';
import { getUvEnvironments } from './uvEnvironments';

let available = createDeferred<boolean>();

/**
 * Reset the UV installation cache.
 */
export function resetUvInstallationCache(): void {
    available = createDeferred<boolean>();
}

export async function isUvInstalled(log?: LogOutputChannel): Promise<boolean> {
    if (available.completed) {
        return available.promise;
    }
    log?.info(`Running: uv --version`);
    const proc = spawnProcess('uv', ['--version']);
    proc.on('error', () => {
        available.resolve(false);
    });
    proc.stdout?.on('data', (d) => log?.info(d.toString()));
    proc.on('exit', (code) => {
        if (code === 0) {
            sendTelemetryEvent(EventNames.VENV_USING_UV);
        }
        available.resolve(code === 0);
    });
    return available.promise;
}

/**
 * Resolves uv from the extension PATH, or from pyprojectx in the owning trusted workspace.
 * @param log Optional command log.
 * @param scope Path inside the workspace whose local uv should be considered.
 * @returns The command to spawn, or undefined when uv is unavailable.
 */
export async function getUvExecutable(log?: LogOutputChannel, scope?: string): Promise<string | undefined> {
    if (await isUvInstalled(log)) {
        return 'uv';
    }
    const workspaceFolder = scope && isWorkspaceTrusted() ? getWorkspaceFolder(Uri.file(scope)) : undefined;
    if (!workspaceFolder) {
        return undefined;
    }
    const executable = path.join(workspaceFolder.uri.fsPath, '.pyprojectx', 'main', process.platform === 'win32' ? 'uv.exe' : 'uv');
    return new Promise((resolve) => {
        log?.info(`Running: ${executable} --version`);
        const proc = spawnProcess(executable, ['--version']);
        proc.on('error', () => resolve(undefined));
        proc.on('exit', (code) => resolve(code === 0 ? executable : undefined));
    });
}

/**
 * Determines if uv should be used for managing a virtual environment.
 * @param log - Optional log output channel for logging operations
 * @param envPath - Optional environment path to check against UV environments list
 * @param scope - Path used to locate the workspace's uv; defaults to the environment path.
 * @returns True if uv should be used, false otherwise. For UV environments, returns true if uv is installed. For other environments, checks the 'python-envs.alwaysUseUv' setting and uv availability.
 */
export async function shouldUseUv(log?: LogOutputChannel, envPath?: string, scope = envPath): Promise<boolean> {
    if (envPath) {
        // always use uv if the given environment is stored as a uv env
        const uvEnvs = await getUvEnvironments();
        if (uvEnvs.includes(envPath)) {
            return (await getUvExecutable(log, scope)) !== undefined;
        }
    }

    // For other environments, check the user setting
    const config = getConfiguration('python-envs');
    const alwaysUseUv = config.get<boolean>('alwaysUseUv', true);

    if (alwaysUseUv) {
        return (await getUvExecutable(log, scope)) !== undefined;
    }
    return false;
}

export async function runUV(
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
    timeout?: number,
    executable = 'uv',
): Promise<string> {
    log?.info(`Running: ${executable} ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const spawnOptions: { cwd?: string; timeout?: number } = { cwd };
        if (timeout !== undefined) {
            spawnOptions.timeout = timeout;
        }
        const proc = spawnProcess(executable, args, spawnOptions);
        let cancellationRequested = false;
        token?.onCancellationRequested(() => {
            cancellationRequested = true;
            try {
                proc.kill();
            } catch {
                // Preserve cancellation when signaling fails.
            }
            reject(new CancellationError());
        });

        proc.on('error', (err) => {
            if (cancellationRequested) {
                reject(new CancellationError());
                return;
            }
            log?.error(`Error spawning uv: ${err}`);
            reject(new Error(`Error spawning uv: ${err.message}`));
        });

        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(s);
        });
        proc.stderr?.on('data', (data) => {
            log?.append(data.toString('utf-8'));
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run uv ${args.join(' ')}`));
            }
        });
    });
}

export async function runPython(
    python: string,
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
    timeout?: number,
): Promise<string> {
    log?.info(`Running: ${python} ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const proc = spawnProcess(python, args, { cwd: cwd, timeout });
        let cancellationRequested = false;
        token?.onCancellationRequested(() => {
            cancellationRequested = true;
            try {
                proc.kill();
            } catch {
                // Preserve cancellation when signaling fails.
            }
            reject(new CancellationError());
        });

        proc.on('error', (err) => {
            if (cancellationRequested) {
                reject(new CancellationError());
                return;
            }
            log?.error(`Error spawning python: ${err}`);
            reject(new Error(`Error spawning python: ${err.message}`));
        });

        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(`python: ${s}`);
        });
        proc.stderr?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(`python: ${s}`);
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run python ${args.join(' ')}`));
            }
        });
    });
}
