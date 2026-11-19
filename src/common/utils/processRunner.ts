// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { ChildProcess, SpawnOptions } from 'child_process';
import { CancellationError, CancellationToken, Disposable, l10n, LogOutputChannel } from 'vscode';
import { spawnProcess } from '../childProcess.apis';
import { traceError } from '../logging';
import { isWindows } from './platformUtils';

export const PROCESS_TERMINATION_TIMEOUT_MS = 5_000;

export class ProcessTimeoutError extends Error {
    constructor(command: string, timeoutMs: number) {
        super(l10n.t('Timed out after {0}ms running {1}.', timeoutMs, command));
        this.name = 'ProcessTimeoutError';
    }
}

export class ProcessTerminationError extends Error {
    constructor(executable: string, public readonly operationError: Error, public readonly cause: unknown) {
        super(
            l10n.t(
                '{0} Unable to stop {1}; it may still be modifying the environment. {2}',
                operationError.message,
                executable,
                cause instanceof Error ? cause.message : String(cause),
            ),
        );
        this.name = 'ProcessTerminationError';
    }
}

function isMissingProcess(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

async function terminateOwnedProcess(proc: ChildProcess, processGroup: boolean, closed: Promise<void>): Promise<void> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminate = async () => {
        let descendantsUnconfirmed = false;
        if (processGroup && proc.pid) {
            try {
                process.kill(-proc.pid, 'SIGKILL');
            } catch (error) {
                if (!isMissingProcess(error)) {
                    throw error;
                }
            }
        } else if (proc.exitCode === null && proc.signalCode === null) {
            if (isWindows() && proc.pid) {
                await new Promise<void>((resolve, reject) => {
                    const killer = spawnProcess('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
                        windowsHide: true,
                        timeout: PROCESS_TERMINATION_TIMEOUT_MS,
                    });
                    killer.on('error', reject);
                    killer.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Unable to terminate process tree ${proc.pid} (taskkill exit ${code}).`));
                        }
                    });
                });
            } else if (!proc.kill() && proc.exitCode === null && proc.signalCode === null) {
                throw new Error('The process did not accept the termination signal.');
            }
        } else if (isWindows() && proc.pid) {
            descendantsUnconfirmed = true;
        }
        // Parent exit does not prove descendant cleanup; never signal a reused Windows PID.
        await closed;
        if (descendantsUnconfirmed) {
            throw new Error(
                l10n.t('The parent process exited before cancellation; child-process cleanup cannot be confirmed.'),
            );
        }
        if (processGroup && proc.pid) {
            while (!expired) {
                try {
                    process.kill(-proc.pid, 0);
                } catch (error) {
                    if (isMissingProcess(error)) {
                        return;
                    }
                    throw error;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
        }
    };
    try {
        await Promise.race([
            terminate(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    expired = true;
                    reject(
                        new Error(
                            l10n.t('Process cleanup did not complete within {0}ms.', PROCESS_TERMINATION_TIMEOUT_MS),
                        ),
                    );
                }, PROCESS_TERMINATION_TIMEOUT_MS);
            }),
        ]);
    } finally {
        expired = true;
        clearTimeout(timer);
    }
}

/** Runs a subprocess and awaits owned-process cleanup on cancellation or timeout. */
export async function runLoggedProcess(
    executable: string,
    args: string[],
    options: SpawnOptions,
    log?: LogOutputChannel,
    token?: CancellationToken,
    timeoutMs?: number,
    includeStderr = false,
): Promise<string> {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }
    const processGroup = !isWindows() && (!!token || timeoutMs !== undefined);
    const spawnOptions = { ...options };
    if (processGroup) {
        spawnOptions.detached = true;
    }
    if (token) {
        spawnOptions.env = { ...options.env, PIP_NO_INPUT: '1', UV_NO_PROGRESS: '1' };
    }
    log?.info(`Running: ${executable} ${args.join(' ')}`);
    const proc = spawnProcess(executable, args, spawnOptions);
    proc.stdin?.end();
    return new Promise<string>((resolve, reject) => {
        let output = '';
        let stderr = '';
        let settled = false;
        let abortError: Error | undefined;
        let exitCode: number | null | undefined;
        let subscription: Disposable | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let resolveClosed: (() => void) | undefined;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            subscription?.dispose();
            if (error) {
                reject(error);
            } else {
                resolve(output);
            }
        };
        const abort = (error: Error) => {
            if (settled || abortError) {
                return;
            }
            abortError = error;
            void terminateOwnedProcess(proc, processGroup, closed).then(
                () => finish(error),
                (killError) => {
                    traceError(`Failed to terminate ${executable}:`, killError);
                    finish(new ProcessTerminationError(executable, error, killError));
                },
            );
        };
        proc.stdout?.on('data', (data) => {
            if (settled) {
                return;
            }
            const text = data.toString('utf-8');
            output += text;
            log?.append(text);
        });
        proc.stderr?.on('data', (data) => {
            if (settled) {
                return;
            }
            const text = data.toString('utf-8');
            stderr += text;
            if (includeStderr) {
                output += text;
            }
            log?.append(text);
        });
        proc.on('error', (error) => {
            if (!abortError) {
                if (proc.pid) {
                    abort(error);
                } else {
                    finish(error);
                }
            }
        });
        proc.on('exit', (code) => {
            exitCode = code;
        });
        proc.on('close', (code, signal) => {
            resolveClosed?.();
            if (!abortError) {
                finish(
                    (code ?? exitCode) === 0
                        ? undefined
                        : new Error(`Failed to run ${executable} (${signal ?? code ?? exitCode}): ${stderr.trim()}`),
                );
            }
        });
        subscription = token?.onCancellationRequested(() => abort(new CancellationError()));
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => abort(new ProcessTimeoutError(executable, timeoutMs)), timeoutMs);
        }
        if (token?.isCancellationRequested) {
            abort(new CancellationError());
        }
    });
}
