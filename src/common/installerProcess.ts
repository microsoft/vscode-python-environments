// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { CancellationError, CancellationToken, Disposable, l10n } from 'vscode';
import { spawnProcess } from './childProcess.apis';
import { traceVerbose } from './logging';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1000;

export interface InstallerProcessOptions {
    readonly timeoutMs?: number;
    readonly cancellationToken?: CancellationToken;
    readonly onOutput?: (text: string) => void;
    readonly maxOutputBytes?: number;
}

export interface InstallerProcessResult {
    readonly stdout: string;
    readonly stderr: string;
}

export class InstallerProcessError extends Error {
    /** Diagnostic output, kept out of the user-facing message and telemetry. */
    public stderr = '';
    /**
     * Describes a process failure without including arguments or potentially sensitive output.
     * Uncertainty also covers descendants or external work that can survive the direct child.
     */
    constructor(
        readonly kind: 'spawn' | 'exit' | 'timeout' | 'output-limit',
        readonly exitCode?: number | null,
        readonly processMayStillBeRunning = false,
        readonly cause?: unknown,
    ) {
        const messages = {
            spawn: l10n.t('The Python installer process could not be started.'),
            exit: l10n.t('The Python installer process failed.'),
            timeout: l10n.t('The Python installer process timed out.'),
            'output-limit': l10n.t('The Python installer process exceeded its output limit.'),
        };
        super(messages[kind]);
        this.name = 'InstallerProcessError';
    }
}

class InstallerCancellationError extends CancellationError {
    constructor(readonly processMayStillBeRunning: boolean) {
        super();
    }
}

function traceLateError(): void {
    traceVerbose('Received an installer process or stream error after completion.');
}

/**
 * Runs an executable directly with piped stdio, bounded output and a finite timeout.
 * @param executable Executable path or command; never interpreted by a shell.
 * @param args Separate, unmodified arguments.
 * @param options Limits, cancellation, and opt-in raw output forwarding.
 * @returns Separate UTF-8 stdout/stderr after the child and its streams close.
 * Cancellation and forced stops wait briefly for close, but cannot guarantee that
 * descendants or external work (such as downloads) have stopped.
 */
export async function runInstallerProcess(
    executable: string,
    args: readonly string[],
    options: InstallerProcessOptions = {},
): Promise<InstallerProcessResult> {
    const { cancellationToken, onOutput } = options;
    if (cancellationToken?.isCancellationRequested) {
        throw new InstallerCancellationError(false);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
        throw new RangeError(l10n.t('The installer timeout must be a finite, non-negative number of milliseconds.'));
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
        throw new RangeError(l10n.t('The installer output limit must be a finite, non-negative number of bytes.'));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
        child = spawnProcess(executable, [...args], { shell: false, windowsHide: true, stdio: 'pipe' });
    } catch (error) {
        throw new InstallerProcessError('spawn', undefined, false, error);
    }

    return new Promise<InstallerProcessResult>((resolve, reject) => {
        const stdout = { decoder: new StringDecoder('utf8'), chunks: [] as string[] };
        const stderr = { decoder: new StringDecoder('utf8'), chunks: [] as string[] };
        let bytes = 0;
        let settled = false;
        let closed = false;
        let exited = false;
        let exitCode: number | null | undefined;
        let failure: InstallerProcessError | InstallerCancellationError | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let grace: ReturnType<typeof setTimeout> | undefined;
        let cancellation: Disposable | undefined;

        function cleanup(): void {
            clearTimeout(timeout);
            clearTimeout(grace);
            cancellation?.dispose();
            child.removeListener('exit', onExit);
            child.removeListener('close', onClose);
            child.stdout.removeListener('data', onStdout);
            child.stderr.removeListener('data', onStderr);
            // Keep only stateless error guards: queued errors (notably stdin EPIPE)
            // can arrive after settlement or while the local pipes are destroyed.
            child.on('error', traceLateError);
            child.removeListener('error', onProcessError);
            child.stdin.on('error', traceLateError);
            child.stdin.removeListener('error', onStdinError);
            for (const stream of [child.stdout, child.stderr]) {
                stream.on('error', traceLateError);
                stream.removeListener('error', onStreamError);
            }
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
        }

        function finish(): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (failure) {
                if (failure instanceof InstallerProcessError) {
                    failure.stderr = stderr.chunks.join('');
                }
                reject(failure);
            } else {
                resolve({ stdout: stdout.chunks.join(''), stderr: stderr.chunks.join('') });
            }
            stdout.chunks.length = 0;
            stderr.chunks.length = 0;
        }

        function stop(error: InstallerProcessError | InstallerCancellationError, signalChild = true): void {
            if (settled || failure) {
                return;
            }
            failure = error;
            clearTimeout(timeout);
            if (closed) {
                return;
            }
            grace = setTimeout(finish, TERMINATION_GRACE_MS);
            if (signalChild && !exited) {
                try {
                    if (!child.kill()) {
                        traceVerbose('Installer termination signal was not accepted; waiting for close.');
                    }
                } catch (_error) {
                    traceVerbose('Installer termination signaling failed; waiting for close.');
                }
            }
        }

        function append(target: typeof stdout, text: string): void {
            if (!text || failure || settled) {
                return;
            }
            target.chunks.push(text);
            try {
                onOutput?.(text);
            } catch (error) {
                stop(new InstallerProcessError('exit', exitCode, !closed, error));
            }
        }

        function capture(target: typeof stdout, data: Buffer | string): void {
            if (failure || settled) {
                return;
            }
            const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            bytes += buffer.length;
            if (bytes > maxOutputBytes) {
                stop(new InstallerProcessError('output-limit', exitCode, true));
                return;
            }
            append(target, target.decoder.write(buffer));
        }

        function onStdout(data: Buffer | string): void {
            capture(stdout, data);
        }

        function onStderr(data: Buffer | string): void {
            capture(stderr, data);
        }

        function onExit(code: number | null): void {
            exited = true;
            exitCode = code;
        }

        function onClose(code: number | null, signal: NodeJS.Signals | null): void {
            closed = true;
            exitCode = code;
            if (!failure && (code !== 0 || signal)) {
                failure = new InstallerProcessError('exit', code, Boolean(signal));
            }
            if (!failure) {
                append(stdout, stdout.decoder.end());
                append(stderr, stderr.decoder.end());
            }
            finish();
        }

        function onProcessError(error: Error): void {
            const mayBeRunning = child.pid !== undefined;
            stop(new InstallerProcessError('spawn', exitCode, mayBeRunning, error), mayBeRunning);
        }

        function onStreamError(error: Error): void {
            stop(new InstallerProcessError('exit', exitCode, !closed, error));
        }

        function onStdinError(error: Error): void {
            if ('code' in error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')) {
                traceVerbose('Installer closed stdin before consuming all input; waiting for close.');
                return;
            }
            onStreamError(error);
        }

        child.on('error', onProcessError);
        child.on('exit', onExit);
        child.on('close', onClose);
        child.stdin.on('error', onStdinError);
        child.stdout.on('error', onStreamError);
        child.stderr.on('error', onStreamError);
        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        timeout = setTimeout(() => stop(new InstallerProcessError('timeout', exitCode, true)), timeoutMs);
        cancellation = cancellationToken?.onCancellationRequested(() => stop(new InstallerCancellationError(true)));
        // Cover cancellation between the initial check and subscribing, including
        // tokens whose registration invokes the callback synchronously.
        if (settled) {
            cancellation?.dispose();
            return;
        }
        if (cancellationToken?.isCancellationRequested) {
            stop(new InstallerCancellationError(true));
        }
        if (!failure) {
            try {
                child.stdin.end();
            } catch (error) {
                onStdinError(error instanceof Error ? error : new Error(l10n.t('Installer input could not be written.')));
            }
        }
    });
}
