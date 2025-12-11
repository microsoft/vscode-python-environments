import assert from 'assert';
import { CancellationTokenSource } from 'vscode';
import {
    timeout,
    createCancelablePromise,
    raceCancellation,
    raceCancellationError,
    CancellationError,
} from '../../../common/utils/asyncUtils';

suite('Async Utils Tests', () => {
    suite('timeout', () => {
        test('should resolve after specified milliseconds', async () => {
            const start = Date.now();
            await timeout(50);
            const elapsed = Date.now() - start;
            assert(elapsed >= 45, `Expected at least 45ms, got ${elapsed}ms`);
        });

        test('should return a CancelablePromise when called without token', () => {
            const promise = timeout(100);
            assert(typeof promise.cancel === 'function', 'Should have cancel method');
            promise.cancel();
        });

        test('should be cancellable via cancel() method', async () => {
            const promise = timeout(100);
            promise.cancel();

            await assert.rejects(
                async () => promise,
                (err: Error) => err instanceof CancellationError,
                'Should reject with CancellationError',
            );
        });

        test('should reject with CancellationError when token is cancelled', async () => {
            const source = new CancellationTokenSource();
            const promise = timeout(100, source.token);

            // Cancel immediately
            source.cancel();

            await assert.rejects(
                async () => promise,
                (err: Error) => err instanceof CancellationError,
                'Should reject with CancellationError',
            );
        });

        test('should resolve normally when token is not cancelled', async () => {
            const source = new CancellationTokenSource();
            const start = Date.now();
            await timeout(50, source.token);
            const elapsed = Date.now() - start;
            assert(elapsed >= 45, `Expected at least 45ms, got ${elapsed}ms`);
        });

        test('should not resolve when cancelled before timeout', async () => {
            const source = new CancellationTokenSource();
            const promise = timeout(1000, source.token);

            // Cancel after a short delay
            setTimeout(() => source.cancel(), 10);

            const start = Date.now();
            await assert.rejects(
                async () => promise,
                (err: Error) => err instanceof CancellationError,
                'Should reject with CancellationError',
            );
            const elapsed = Date.now() - start;
            assert(elapsed < 100, `Should cancel quickly, took ${elapsed}ms`);
        });
    });

    suite('createCancelablePromise', () => {
        test('should create a promise that can be cancelled', async () => {
            const promise = createCancelablePromise(async () => {
                await timeout(100);
                return 'completed';
            });

            promise.cancel();

            await assert.rejects(
                async () => promise,
                (err: Error) => err instanceof CancellationError,
                'Should reject with CancellationError',
            );
        });

        test('should resolve normally when not cancelled', async () => {
            const promise = createCancelablePromise(async () => {
                await timeout(10);
                return 'completed';
            });

            const result = await promise;
            assert.strictEqual(result, 'completed', 'Should resolve with expected value');
        });

        test('should pass cancellation token to callback', async () => {
            let tokenReceived = false;
            const promise = createCancelablePromise(async (token) => {
                tokenReceived = token !== undefined;
                return 'done';
            });

            await promise;
            assert(tokenReceived, 'Token should be passed to callback');
        });

        test('should reject when callback throws', async () => {
            const promise = createCancelablePromise(async () => {
                throw new Error('test error');
            });

            await assert.rejects(
                async () => promise,
                (err: Error) => err.message === 'test error',
                'Should reject with the thrown error',
            );
        });

        test('should support promise chaining with then', async () => {
            const promise = createCancelablePromise(async () => 42);
            const result = await promise.then((value) => value * 2);
            assert.strictEqual(result, 84, 'Should support then chaining');
        });

        test('should support promise chaining with catch', async () => {
            const promise = createCancelablePromise(async () => {
                throw new Error('test');
            });
            const result = await promise.catch(() => 'caught');
            assert.strictEqual(result, 'caught', 'Should support catch chaining');
        });

        test('should support promise chaining with finally', async () => {
            let finallyCalled = false;
            const promise = createCancelablePromise(async () => 42);
            await promise.finally(() => {
                finallyCalled = true;
            });
            assert(finallyCalled, 'Should support finally chaining');
        });
    });

    suite('raceCancellation', () => {
        test('should resolve with promise value when not cancelled', async () => {
            const source = new CancellationTokenSource();
            const promise = Promise.resolve('value');
            const result = await raceCancellation(promise, source.token);
            assert.strictEqual(result, 'value', 'Should resolve with promise value');
        });

        test('should resolve with undefined when cancelled', async () => {
            const source = new CancellationTokenSource();
            const promise = new Promise((resolve) => setTimeout(() => resolve('value'), 100));

            const racePromise = raceCancellation(promise, source.token);
            // Cancel after a microtask to allow event subscription
            await Promise.resolve();
            source.cancel();

            const result = await racePromise;
            assert.strictEqual(result, undefined, 'Should resolve with undefined when cancelled');
        });

        test('should resolve with default value when cancelled', async () => {
            const source = new CancellationTokenSource();
            const promise = new Promise((resolve) => setTimeout(() => resolve('value'), 100));

            const racePromise = raceCancellation(promise, source.token, 'default');
            // Cancel after a microtask to allow event subscription
            await Promise.resolve();
            source.cancel();

            const result = await racePromise;
            assert.strictEqual(result, 'default', 'Should resolve with default value when cancelled');
        });

        test('should reject if promise rejects', async () => {
            const source = new CancellationTokenSource();
            const promise = Promise.reject(new Error('test error'));

            await assert.rejects(
                async () => raceCancellation(promise, source.token),
                (err: Error) => err.message === 'test error',
                'Should reject with promise rejection',
            );
        });

        test('should race between promise and cancellation', async () => {
            const source = new CancellationTokenSource();
            const promise = new Promise((resolve) => setTimeout(() => resolve('slow'), 100));

            // Cancel after a short delay
            setTimeout(() => source.cancel(), 10);

            const result = await raceCancellation(promise, source.token, 'cancelled');
            assert.strictEqual(result, 'cancelled', 'Should resolve with cancelled value');
        });
    });

    suite('raceCancellationError', () => {
        test('should resolve with promise value when not cancelled', async () => {
            const source = new CancellationTokenSource();
            const promise = Promise.resolve('value');
            const result = await raceCancellationError(promise, source.token);
            assert.strictEqual(result, 'value', 'Should resolve with promise value');
        });

        test('should reject with CancellationError when cancelled', async () => {
            const source = new CancellationTokenSource();
            const promise = new Promise((resolve) => setTimeout(() => resolve('value'), 100));

            const racePromise = raceCancellationError(promise, source.token);
            // Cancel after a microtask to allow event subscription
            await Promise.resolve();
            source.cancel();

            await assert.rejects(
                async () => racePromise,
                (err: Error) => err instanceof CancellationError,
                'Should reject with CancellationError',
            );
        });

        test('should reject if promise rejects', async () => {
            const source = new CancellationTokenSource();
            const promise = Promise.reject(new Error('test error'));

            await assert.rejects(
                async () => raceCancellationError(promise, source.token),
                (err: Error) => err.message === 'test error',
                'Should reject with promise rejection',
            );
        });

        test('should race between promise and cancellation', async () => {
            const source = new CancellationTokenSource();
            const promise = new Promise((resolve) => setTimeout(() => resolve('slow'), 100));

            // Cancel after a short delay
            setTimeout(() => source.cancel(), 10);

            await assert.rejects(
                async () => raceCancellationError(promise, source.token),
                (err: Error) => err instanceof CancellationError,
                'Should reject with CancellationError',
            );
        });
    });

    suite('CancellationError', () => {
        test('should be instanceof Error', () => {
            const error = new CancellationError();
            assert(error instanceof Error, 'Should be instanceof Error');
        });

        test('should have correct message', () => {
            const error = new CancellationError();
            assert.strictEqual(error.message, 'Cancelled', 'Should have "Cancelled" message');
        });

        test('should have correct name', () => {
            const error = new CancellationError();
            assert.strictEqual(error.name, 'CancellationError', 'Should have "CancellationError" name');
        });
    });
});
