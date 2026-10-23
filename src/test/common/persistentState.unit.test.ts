// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { Memento } from 'vscode';
import { createPersistentState } from '../../common/persistentState';

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Persistent state operation remained blocked')), 250);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

suite('Persistent state', () => {
    test('releases later reads and writes after a clear fails', async () => {
        const store = new Map<string, unknown>([['stale', 'value']]);
        const failure = new Error('storage update failed');
        let failClear = true;
        const memento = {
            get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : defaultValue),
            update: async (key: string, value: unknown) => {
                if (key === 'stale' && value === undefined && failClear) {
                    failClear = false;
                    throw failure;
                }
                if (value === undefined) {
                    store.delete(key);
                } else {
                    store.set(key, value);
                }
            },
            keys: () => [...store.keys()],
        } as Memento;
        const state = createPersistentState(memento);

        await assert.rejects(state.clear(['stale']), (error: unknown) => error === failure);

        assert.strictEqual(await withTimeout(state.get<string>('stale')), 'value');
        await withTimeout(state.set('fresh', 'saved'));
        assert.strictEqual(store.get('fresh'), 'saved');

        await withTimeout(state.clear(['stale']));
        assert.strictEqual(store.has('stale'), false);
    });

    test('waits for every deletion to settle before releasing operations after a failure', async () => {
        const store = new Map<string, unknown>([
            ['fails', 'value'],
            ['delayed', 'value'],
        ]);
        const failure = new Error('first deletion failed');
        let releaseDelayedDeletion: (() => void) | undefined;
        let delayedDeletionStarted: (() => void) | undefined;
        const delayedStarted = new Promise<void>((resolve) => {
            delayedDeletionStarted = resolve;
        });
        const delayedRelease = new Promise<void>((resolve) => {
            releaseDelayedDeletion = resolve;
        });
        const memento = {
            get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : defaultValue),
            update: async (key: string, value: unknown) => {
                if (key === 'fails' && value === undefined) {
                    throw failure;
                }
                if (key === 'delayed' && value === undefined) {
                    delayedDeletionStarted!();
                    await delayedRelease;
                }
                if (value === undefined) {
                    store.delete(key);
                } else {
                    store.set(key, value);
                }
            },
            keys: () => [...store.keys()],
        } as Memento;
        const state = createPersistentState(memento);

        const clearing = state.clear(['fails', 'delayed']);
        await delayedStarted;
        let readCompleted = false;
        const readDuringClear = state.get<string>('delayed').then((value) => {
            readCompleted = true;
            return value;
        });
        let writeCompleted = false;
        const writeDuringClear = state.set('delayed', 'new selection').then(() => {
            writeCompleted = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(readCompleted, false, 'reads must remain blocked while a sibling deletion is pending');
        assert.strictEqual(writeCompleted, false, 'writes must remain blocked while a sibling deletion is pending');

        releaseDelayedDeletion!();
        await assert.rejects(clearing, (error: unknown) => error === failure);
        assert.strictEqual(await withTimeout(readDuringClear), undefined);
        await withTimeout(writeDuringClear);
        assert.strictEqual(store.get('delayed'), 'new selection');
    });
});