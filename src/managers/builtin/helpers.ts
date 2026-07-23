import { CancellationError, CancellationToken, LogOutputChannel } from 'vscode';
import { spawnProcess } from '../../common/childProcess.apis';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred } from '../../common/utils/deferred';
import { getConfiguration } from '../../common/workspace.apis';
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
 * Determines if uv should be used for managing a virtual environment.
 * @param log - Optional log output channel for logging operations
 * @param envPath - Optional environment path to check against UV environments list
 * @returns True if uv should be used, false otherwise. For UV environments, returns true if uv is installed. For other environments, checks the 'python-envs.alwaysUseUv' setting and uv availability.
 */
export async function shouldUseUv(log?: LogOutputChannel, envPath?: string): Promise<boolean> {
    if (envPath) {
        // always use uv if the given environment is stored as a uv env
        const uvEnvs = await getUvEnvironments();
        if (uvEnvs.includes(envPath)) {
            return await isUvInstalled(log);
        }
    }

    // For other environments, check the user setting
    const config = getConfiguration('python-envs');
    const alwaysUseUv = config.get<boolean>('alwaysUseUv', true);

    if (alwaysUseUv) {
        return await isUvInstalled(log);
    }
    return false;
}

export async function runUV(
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
    timeout?: number,
): Promise<string> {
    return runProcess('uv', args, {
        cwd,
        displayName: 'uv',
        log,
        token,
        timeout,
        collectStderr: false,
        logPrefix: '',
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
    return runProcess(python, args, {
        cwd,
        displayName: 'python',
        log,
        token,
        timeout,
        collectStderr: true,
        logPrefix: 'python: ',
    });
}

function runProcess(executable: string, args: string[], options: RunProcessOptions): Promise<string> {
    options.log?.info(`Running: ${executable} ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const spawnOptions: { cwd?: string; timeout?: number } = { cwd: options.cwd };
        if (options.timeout !== undefined) {
            spawnOptions.timeout = options.timeout;
        }
        const proc = spawnProcess(executable, args, spawnOptions);
        let cancellationRequested = false;
        options.token?.onCancellationRequested(() => {
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
            options.log?.error(`Error spawning ${options.displayName}: ${err}`);
            reject(new Error(`Error spawning ${options.displayName}: ${err.message}`));
        });

        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            options.log?.append(`${options.logPrefix}${s}`);
        });
        proc.stderr?.on('data', (data) => {
            const s = data.toString('utf-8');
            if (options.collectStderr) {
                builder += s;
            }
            options.log?.append(`${options.logPrefix}${s}`);
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run ${options.displayName} ${args.join(' ')}`));
            }
        });
    });
}

interface RunProcessOptions {
    readonly cwd?: string;
    readonly displayName: 'python' | 'uv';
    readonly log?: LogOutputChannel;
    readonly token?: CancellationToken;
    readonly timeout?: number;
    readonly collectStderr: boolean;
    readonly logPrefix: string;
}
