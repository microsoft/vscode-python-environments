// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Test utilities for E2E and smoke tests.
 *
 * These utilities are designed to work with REAL VS Code APIs,
 * not the mocked APIs used in unit tests.
 */

import type { Disposable, Event } from 'vscode';

/**
 * Sleep for a specified number of milliseconds.
 * Use sparingly - prefer waitForCondition() for most cases.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to become true within a timeout.
 *
 * This is the PRIMARY utility for smoke/E2E tests. Use this instead of sleep()
 * for any async assertion that depends on VS Code state.
 *
 * @param condition - Async function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait (default: 10 seconds)
 * @param errorMessage - Error message if condition is not met
 * @param pollIntervalMs - How often to check condition (default: 100ms)
 *
 * @example
 * // Wait for extension to activate
 * await waitForCondition(
 *     () => extension.isActive,
 *     10_000,
 *     'Extension did not activate within 10 seconds'
 * );
 *
 * @example
 * // Wait for file to exist
 * await waitForCondition(
 *     async () => fs.pathExists(outputFile),
 *     30_000,
 *     `Output file ${outputFile} was not created`
 * );
 */
export async function waitForCondition(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number = 10_000,
    errorMessage: string = 'Condition not met within timeout',
    pollIntervalMs: number = 100,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const startTime = Date.now();

        const checkCondition = async () => {
            try {
                const result = await condition();
                if (result) {
                    resolve();
                    return;
                }
            } catch {
                // Condition threw - keep waiting
            }

            if (Date.now() - startTime >= timeoutMs) {
                reject(new Error(`${errorMessage} (waited ${timeoutMs}ms)`));
                return;
            }

            setTimeout(checkCondition, pollIntervalMs);
        };

        checkCondition();
    });
}

/**
 * Retry an async function until it succeeds or timeout is reached.
 *
 * Similar to waitForCondition but captures the return value.
 *
 * @example
 * const envs = await retryUntilSuccess(
 *     () => api.getEnvironments(),
 *     (envs) => envs.length > 0,
 *     10_000,
 *     'No environments discovered'
 * );
 */
export async function retryUntilSuccess<T>(
    fn: () => T | Promise<T>,
    validate: (result: T) => boolean = () => true,
    timeoutMs: number = 10_000,
    errorMessage: string = 'Operation did not succeed within timeout',
): Promise<T> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    while (Date.now() - startTime < timeoutMs) {
        try {
            const result = await fn();
            if (validate(result)) {
                return result;
            }
        } catch (e) {
            lastError = e as Error;
        }
        await sleep(100);
    }

    throw new Error(`${errorMessage}: ${lastError?.message || 'validation failed'}`);
}

/**
 * Helper class to test events.
 *
 * Captures events and provides assertion helpers.
 *
 * @example
 * const handler = new TestEventHandler(api.onDidChangeEnvironments, 'onDidChangeEnvironments');
 * // ... trigger some action that fires events ...
 * await handler.assertFiredAtLeast(1, 5000);
 * assert.strictEqual(handler.first.type, 'add');
 * handler.dispose();
 */
export class TestEventHandler<T> implements Disposable {
    private readonly handledEvents: T[] = [];
    private readonly disposable: Disposable;

    constructor(
        event: Event<T>,
        private readonly eventName: string = 'event',
    ) {
        this.disposable = event((e) => this.handledEvents.push(e));
    }

    /** Whether any events have been fired */
    get fired(): boolean {
        return this.handledEvents.length > 0;
    }

    /** The first event fired (throws if none) */
    get first(): T {
        if (this.handledEvents.length === 0) {
            throw new Error(`No ${this.eventName} events fired yet`);
        }
        return this.handledEvents[0];
    }

    /** The last event fired (throws if none) */
    get last(): T {
        if (this.handledEvents.length === 0) {
            throw new Error(`No ${this.eventName} events fired yet`);
        }
        return this.handledEvents[this.handledEvents.length - 1];
    }

    /** Number of events fired */
    get count(): number {
        return this.handledEvents.length;
    }

    /** All events fired */
    get all(): T[] {
        return [...this.handledEvents];
    }

    /** Get event at specific index */
    at(index: number): T {
        return this.handledEvents[index];
    }

    /** Reset captured events */
    reset(): void {
        this.handledEvents.length = 0;
    }

    /** Wait for at least one event to fire */
    async assertFired(waitMs: number = 1000): Promise<void> {
        await waitForCondition(() => this.fired, waitMs, `${this.eventName} was not fired`);
    }

    /** Wait for exactly N events to fire */
    async assertFiredExactly(count: number, waitMs: number = 2000): Promise<void> {
        await waitForCondition(
            () => this.count === count,
            waitMs,
            `Expected ${this.eventName} to fire ${count} times, but fired ${this.count} times`,
        );
    }

    /** Wait for at least N events to fire */
    async assertFiredAtLeast(count: number, waitMs: number = 2000): Promise<void> {
        await waitForCondition(
            () => this.count >= count,
            waitMs,
            `Expected ${this.eventName} to fire at least ${count} times, but fired ${this.count} times`,
        );
    }

    dispose(): void {
        this.disposable.dispose();
    }
}
