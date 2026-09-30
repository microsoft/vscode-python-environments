import { traceError } from '../logging';
import { EventNames } from '../telemetry/constants';
import { classifyError } from '../telemetry/errorClassifier';
import { sendTelemetryEvent } from '../telemetry/sender';
import { CancellationError, CancellationToken, CancellationTokenSource } from 'vscode';

export interface CancelablePromise<T> extends Promise<T> {
    cancel(): void;
}

export function timeout(milliseconds: number): CancelablePromise<void>;
export function timeout(milliseconds: number, token: CancellationToken): Promise<void>;
export function timeout(milliseconds: number, token?: CancellationToken): CancelablePromise<void> | Promise<void> {
    if (!token) {
        const source = new CancellationTokenSource();
        const promise = timeout(milliseconds, source.token);
        return Object.assign(promise, {
            cancel: () => {
                source.cancel();
                source.dispose();
            },
        });
    }

    return new Promise<void>((resolve, reject) => {
        const handle = setTimeout(() => {
            disposable.dispose();
            resolve();
        }, milliseconds);
        const disposable = token.onCancellationRequested(() => {
            clearTimeout(handle);
            disposable.dispose();
            reject(new CancellationError());
        });
    });
}

/**
 * Wraps a promise so that rejection is caught and logged instead of propagated.
 * Use with `Promise.all` to run tasks independently — one failure won't block the others.
 */
export async function safeRegister(name: string, task: Promise<void>): Promise<void> {
    try {
        await task;
    } catch (error) {
        traceError(`Failed to register ${name} features:`, error);
        const failureStage =
            error instanceof Error
                ? ((error as Error & { failureStage?: string }).failureStage ?? 'unknown')
                : 'unknown';
        sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_FAILED, undefined, {
            managerName: name,
            errorType: classifyError(error),
            failureStage,
        });
    }
}
