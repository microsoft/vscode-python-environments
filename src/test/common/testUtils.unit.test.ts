// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { retryUntilSuccess, sleep, waitForApiReady, waitForCondition } from '../testUtils';

suite('Test Utilities', () => {
    suite('sleep', () => {
        test('should resolve after specified time', async () => {
            const start = Date.now();
            await sleep(50);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 45, `Expected at least 45ms, got ${elapsed}ms`);
        });
    });

    suite('waitForCondition', () => {
        test('should resolve immediately when condition is true', async () => {
            await waitForCondition(() => true, 100, 'Should not fail');
        });

        test('should resolve when condition becomes true', async () => {
            let counter = 0;
            await waitForCondition(
                () => {
                    counter++;
                    return counter >= 3;
                },
                1000,
                'Condition did not become true',
                10,
            );
            assert.ok(counter >= 3, 'Condition should have been checked multiple times');
        });

        test('should reject when timeout is reached', async () => {
            await assert.rejects(
                () => waitForCondition(() => false, 100, 'Custom error message', 10),
                /Custom error message \(waited 100ms\)/,
            );
        });

        test('should handle async conditions', async () => {
            let counter = 0;
            await waitForCondition(
                async () => {
                    counter++;
                    await sleep(5);
                    return counter >= 2;
                },
                1000,
                'Async condition failed',
                10,
            );
            assert.ok(counter >= 2);
        });

        test('should continue polling when condition throws', async () => {
            let counter = 0;
            await waitForCondition(
                () => {
                    counter++;
                    if (counter < 3) {
                        throw new Error('Not ready yet');
                    }
                    return true;
                },
                1000,
                'Should eventually succeed',
                10,
            );
            assert.ok(counter >= 3);
        });
    });

    suite('retryUntilSuccess', () => {
        test('should return result when function succeeds immediately', async () => {
            const result = await retryUntilSuccess(
                () => 42,
                () => true,
                1000,
                'Should not fail',
            );
            assert.strictEqual(result, 42);
        });

        test('should return result when validation passes', async () => {
            let counter = 0;
            const result = await retryUntilSuccess(
                () => {
                    counter++;
                    return counter;
                },
                (val) => val >= 3,
                1000,
                'Validation failed',
            );
            assert.ok(result >= 3);
        });

        test('should reject when timeout reached', async () => {
            await assert.rejects(
                () =>
                    retryUntilSuccess(
                        () => 1,
                        (val) => val > 10,
                        100,
                        'Custom timeout error',
                    ),
                /Custom timeout error: validation failed/,
            );
        });

        test('should include last error message in rejection', async () => {
            await assert.rejects(
                () =>
                    retryUntilSuccess(
                        () => {
                            throw new Error('Specific failure');
                        },
                        () => true,
                        100,
                        'Operation failed',
                    ),
                /Operation failed: Specific failure/,
            );
        });

        test('should handle async functions', async () => {
            let counter = 0;
            const result = await retryUntilSuccess(
                async () => {
                    counter++;
                    await sleep(5);
                    return counter;
                },
                (val) => val >= 2,
                1000,
                'Async retry failed',
            );
            assert.ok(result >= 2);
        });
    });

    suite('waitForApiReady', () => {
        test('should return ready:true when getEnvironments succeeds', async () => {
            const mockApi = {
                getEnvironments: async () => [],
            };
            const result = await waitForApiReady(mockApi, 1000);
            assert.deepStrictEqual(result, { ready: true });
        });

        test('should return ready:false with error when timeout reached', async () => {
            const mockApi = {
                getEnvironments: (): Promise<unknown[]> => new Promise(() => {}), // Never resolves
            };
            const result = await waitForApiReady(mockApi, 100);
            assert.strictEqual(result.ready, false);
            assert.ok(result.error?.includes('API not ready within 100ms'));
        });

        test('should return ready:false when getEnvironments throws', async () => {
            const mockApi = {
                getEnvironments: async () => {
                    throw new Error('Manager not registered');
                },
            };
            const result = await waitForApiReady(mockApi, 1000);
            assert.strictEqual(result.ready, false);
            assert.ok(result.error?.includes('Manager not registered'));
        });
    });
});
