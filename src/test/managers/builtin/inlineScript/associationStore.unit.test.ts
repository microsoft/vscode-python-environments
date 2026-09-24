// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Memento } from 'vscode';
import { INLINE_SCRIPT_ENVS_KEY } from '../../../../common/constants';
import * as logging from '../../../../common/logging';
import { InlineScriptAssociationStore } from '../../../../managers/builtin/inlineScript/associationStore';

function createMemento(initial?: Record<string, unknown>): { memento: Memento; store: Map<string, unknown> } {
    const store = new Map<string, unknown>(initial ? Object.entries(initial) : []);
    const memento = {
        get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : defaultValue),
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
        keys: () => [...store.keys()],
    } as unknown as Memento;
    return { memento, store };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('InlineScriptAssociationStore', () => {
    teardown(() => {
        sinon.restore();
    });

    test('runs queued operations strictly in invocation order', async () => {
        const { memento } = createMemento();
        const store = new InlineScriptAssociationStore(memento);
        const order: number[] = [];

        const first = store.runExclusive(async () => {
            await delay(10);
            order.push(1);
        });
        const second = store.runExclusive(async () => {
            order.push(2);
        });
        const third = store.runExclusive(async () => {
            await delay(5);
            order.push(3);
        });

        await Promise.all([first, second, third]);
        assert.deepStrictEqual(order, [1, 2, 3]);
    });

    test('serializes a read-modify-write transaction as one atomic queue entry', async () => {
        const { memento, store: backing } = createMemento();
        const store = new InlineScriptAssociationStore(memento);

        // Two interleaved read-modify-writes must not clobber each other.
        const writeA = store.runExclusive(async (state) => {
            const current = ((await state.get<Record<string, string>>()) ?? {}) as Record<string, string>;
            await delay(10);
            await state.update({ ...current, 'a.py': 'env-a' });
        });
        const writeB = store.runExclusive(async (state) => {
            const current = ((await state.get<Record<string, string>>()) ?? {}) as Record<string, string>;
            await state.update({ ...current, 'b.py': 'env-b' });
        });

        await Promise.all([writeA, writeB]);
        assert.deepStrictEqual(backing.get(INLINE_SCRIPT_ENVS_KEY), { 'a.py': 'env-a', 'b.py': 'env-b' });
    });

    test('a dedicated clear queued behind an in-flight write wins and is not resurrected', async () => {
        const { memento, store: backing } = createMemento();
        const store = new InlineScriptAssociationStore(memento);

        let releaseWrite!: () => void;
        const writeGate = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });

        const writePromise = store.runExclusive(async (state) => {
            await writeGate;
            await state.update({ 'a.py': 'env-a' });
        });
        // Request the deletion while the write is still in flight.
        const clearPromise = store.clear();
        releaseWrite();
        await Promise.all([writePromise, clearPromise]);

        assert.strictEqual(backing.has(INLINE_SCRIPT_ENVS_KEY), false);
        assert.strictEqual(await store.read(), undefined);
    });

    test('a failed operation rejects its caller but the queue keeps running later operations', async () => {
        const { memento, store: backing } = createMemento();
        const store = new InlineScriptAssociationStore(memento);

        const failing = store.runExclusive(async () => {
            throw new Error('boom');
        });
        // Queue a follow-up behind the failing operation before awaiting the rejection.
        const later = store.runExclusive((state) => state.update({ 'b.py': 'env-b' }));

        await assert.rejects(failing, /boom/);
        await later;
        assert.deepStrictEqual(backing.get(INLINE_SCRIPT_ENVS_KEY), { 'b.py': 'env-b' });
    });

    test('read returns the latest value written through the queue', async () => {
        const { memento } = createMemento();
        const store = new InlineScriptAssociationStore(memento);

        assert.strictEqual(await store.read(), undefined);
        await store.runExclusive((state) => state.update({ 'c.py': 'env-c' }));
        assert.deepStrictEqual(await store.read(), { 'c.py': 'env-c' });
        await store.clear();
        assert.strictEqual(await store.read(), undefined);
    });

    test('a verified write clears the key and logs when the read-back does not match', async () => {
        const traceErrorStub = sinon.stub(logging, 'traceError');
        const backing = new Map<string, unknown>();
        const memento = {
            get: <T>(key: string) => backing.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    backing.delete(key);
                }
                // Silently drop non-undefined writes to force a read-back mismatch.
            },
            keys: () => [...backing.keys()],
        } as unknown as Memento;
        const store = new InlineScriptAssociationStore(memento);

        await store.runExclusive((state) => state.update({ 'd.py': 'env-d' }));

        assert.strictEqual(backing.has(INLINE_SCRIPT_ENVS_KEY), false, 'a corrupt write must not be left persisted');
        sinon.assert.calledWithMatch(traceErrorStub, sinon.match.string, INLINE_SCRIPT_ENVS_KEY);
    });

    test('store operations resolve independently of a wedged external clear promise', async () => {
        const { memento, store: backing } = createMemento();
        const store = new InlineScriptAssociationStore(memento);

        // Simulate a wedged shared PersistentState.clear() that never settles. The inline store
        // holds no reference to it, so its own operations must still complete promptly.
        const wedged = new Promise<void>(() => undefined);
        void wedged;

        const timeout = delay(1000).then(() => 'timeout' as const);
        const write = (async () => {
            await store.runExclusive((state) => state.update({ 'e.py': 'env-e' }));
            return 'done' as const;
        })();
        assert.strictEqual(await Promise.race([write, timeout]), 'done');
        assert.deepStrictEqual(backing.get(INLINE_SCRIPT_ENVS_KEY), { 'e.py': 'env-e' });

        const clear = (async () => {
            await store.clear();
            return 'done' as const;
        })();
        assert.strictEqual(await Promise.race([clear, timeout]), 'done');
        assert.strictEqual(backing.has(INLINE_SCRIPT_ENVS_KEY), false);
    });
});
