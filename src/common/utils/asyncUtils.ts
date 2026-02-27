import { CancellationToken, CancellationTokenSource } from 'vscode';

/**
 * A promise that can be cancelled using the `.cancel()` method.
 */
export interface CancelablePromise<T> extends Promise<T> {
    cancel(): void;
}

/**
 * Error thrown when a promise is cancelled.
 */
export class CancellationError extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'CancellationError';
    }
}

/**
 * Returns a promise that can be cancelled using the provided cancellation token.
 *
 * @remarks When cancellation is requested, the promise will be rejected with a {@link CancellationError}.
 *
 * @param callback A function that accepts a cancellation token and returns a promise
 * @returns A promise that can be cancelled
 */
export function createCancelablePromise<T>(callback: (token: CancellationToken) => Promise<T>): CancelablePromise<T> {
    const source = new CancellationTokenSource();

    const thenable = callback(source.token);
    const promise = new Promise<T>((resolve, reject) => {
        const subscription = source.token.onCancellationRequested(() => {
            subscription.dispose();
            reject(new CancellationError());
        });
        Promise.resolve(thenable).then(
            (value) => {
                subscription.dispose();
                source.dispose();
                resolve(value);
            },
            (err) => {
                subscription.dispose();
                source.dispose();
                reject(err);
            },
        );
    });

    return new (class {
        cancel() {
            source.cancel();
            source.dispose();
        }
        then<TResult1 = T, TResult2 = never>(
            resolve?: ((value: T) => TResult1 | Promise<TResult1>) | undefined | null,
            reject?: ((reason: unknown) => TResult2 | Promise<TResult2>) | undefined | null,
        ): Promise<TResult1 | TResult2> {
            return promise.then(resolve, reject);
        }
        catch<TResult = never>(
            reject?: ((reason: unknown) => TResult | Promise<TResult>) | undefined | null,
        ): Promise<T | TResult> {
            return this.then(undefined, reject);
        }
        finally(onfinally?: (() => void) | undefined | null): Promise<T> {
            return promise.finally(onfinally);
        }
    })() as CancelablePromise<T>;
}

/**
 * Returns a promise that resolves with `undefined` as soon as the passed token is cancelled.
 * @see {@link raceCancellationError}
 */
export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken): Promise<T | undefined>;

/**
 * Returns a promise that resolves with `defaultValue` as soon as the passed token is cancelled.
 * @see {@link raceCancellationError}
 */
export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken, defaultValue: T): Promise<T>;

export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken, defaultValue?: T): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const ref = token.onCancellationRequested(() => {
            ref.dispose();
            resolve(defaultValue);
        });
        promise.then(resolve, reject).finally(() => ref.dispose());
    });
}

/**
 * Returns a promise that rejects with a {@link CancellationError} as soon as the passed token is cancelled.
 * @see {@link raceCancellation}
 */
export function raceCancellationError<T>(promise: Promise<T>, token: CancellationToken): Promise<T> {
    return new Promise((resolve, reject) => {
        const ref = token.onCancellationRequested(() => {
            ref.dispose();
            reject(new CancellationError());
        });
        promise.then(resolve, reject).finally(() => ref.dispose());
    });
}

/**
 * Creates a timeout promise that resolves after the specified number of milliseconds.
 * Can be cancelled using the returned CancelablePromise's cancel() method.
 */
export function timeout(millis: number): CancelablePromise<void>;

/**
 * Creates a timeout promise that resolves after the specified number of milliseconds,
 * or rejects with CancellationError if the token is cancelled.
 */
export function timeout(millis: number, token: CancellationToken): Promise<void>;

export function timeout(millis: number, token?: CancellationToken): CancelablePromise<void> | Promise<void> {
    if (!token) {
        return createCancelablePromise((token) => timeout(millis, token));
    }

    return new Promise((resolve, reject) => {
        const handle = setTimeout(() => {
            disposable.dispose();
            resolve();
        }, millis);
        const disposable = token.onCancellationRequested(() => {
            clearTimeout(handle);
            disposable.dispose();
            reject(new CancellationError());
        });
    });
}
