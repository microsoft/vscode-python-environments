import { traceError } from '../logging';

export async function timeout(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
    }
}
