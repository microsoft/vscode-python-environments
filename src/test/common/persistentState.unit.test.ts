// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { ExtensionContext, Memento } from 'vscode';
import { INLINE_SCRIPT_ENVS_KEY } from '../../common/constants';
import {
    clearPersistentState,
    getWorkspacePersistentState,
    PersistentState,
    setPersistentState,
} from '../../common/persistentState';

suite('persistent state clearing', () => {
    let workspace: TestMemento;
    let global: TestMemento;
    let workspaceState: PersistentState;

    suiteSetup(async () => {
        workspace = createMemento();
        global = createMemento();
        setPersistentState({
            workspaceState: workspace.memento,
            globalState: global.memento,
        } as ExtensionContext);
        workspaceState = await getWorkspacePersistentState();
    });

    setup(() => {
        workspace.reset();
        global.reset();
    });

    test('clears selected scopes without snapshotting or rewriting preserved inline associations', async () => {
        const inlineAssociations = { 'C:\\workspace\\script.py': 'C:\\cache\\python.exe' };
        workspace.reset({
            [INLINE_SCRIPT_ENVS_KEY]: inlineAssociations,
            'other-workspace-key': 'remove',
        });
        global.reset({ 'other-global-key': 'remove' });

        await clearPersistentState({ preserveWorkspaceKeys: [INLINE_SCRIPT_ENVS_KEY] });

        assert.deepStrictEqual(workspace.values.get(INLINE_SCRIPT_ENVS_KEY), inlineAssociations);
        assert.strictEqual(workspace.values.has('other-workspace-key'), false);
        assert.strictEqual(global.values.has('other-global-key'), false);
        assert.deepStrictEqual(
            workspace.updates.filter((update) => update.key === INLINE_SCRIPT_ENVS_KEY),
            [],
            'the preserved value must not be snapshot-restored through Memento.update',
        );
    });

    test('serializes generic preserve before a racing dedicated inline clear', async () => {
        workspace.reset({
            [INLINE_SCRIPT_ENVS_KEY]: { script: 'environment' },
            'other-workspace-key': 'remove',
        });
        const gate = createGate();
        workspace.beforeUpdate = async (key) => {
            if (key === 'other-workspace-key') {
                gate.started.resolve();
                await gate.release.promise;
            }
        };

        const genericClear = clearPersistentState({ preserveWorkspaceKeys: [INLINE_SCRIPT_ENVS_KEY] });
        await gate.started.promise;
        const dedicatedClear = workspaceState.clear([INLINE_SCRIPT_ENVS_KEY]);

        assert.strictEqual(workspace.values.has(INLINE_SCRIPT_ENVS_KEY), true);
        gate.release.resolve();
        await genericClear;
        await dedicatedClear;

        assert.strictEqual(workspace.values.has('other-workspace-key'), false);
        assert.strictEqual(workspace.values.has(INLINE_SCRIPT_ENVS_KEY), false);
        assert.deepStrictEqual(
            workspace.updates.map((update) => update.key),
            ['other-workspace-key', INLINE_SCRIPT_ENVS_KEY],
        );
    });

    test('serializes dedicated inline clear before a racing generic preserve', async () => {
        workspace.reset({
            [INLINE_SCRIPT_ENVS_KEY]: { script: 'environment' },
            'other-workspace-key': 'remove',
        });
        const gate = createGate();
        workspace.beforeUpdate = async (key) => {
            if (key === INLINE_SCRIPT_ENVS_KEY) {
                gate.started.resolve();
                await gate.release.promise;
            }
        };

        const dedicatedClear = workspaceState.clear([INLINE_SCRIPT_ENVS_KEY]);
        await gate.started.promise;
        const genericClear = clearPersistentState({ preserveWorkspaceKeys: [INLINE_SCRIPT_ENVS_KEY] });

        gate.release.resolve();
        await dedicatedClear;
        await genericClear;

        assert.strictEqual(workspace.values.has(INLINE_SCRIPT_ENVS_KEY), false);
        assert.strictEqual(workspace.values.has('other-workspace-key'), false);
        assert.deepStrictEqual(
            workspace.updates.map((update) => update.key),
            [INLINE_SCRIPT_ENVS_KEY, 'other-workspace-key'],
        );
    });

    test('settles the queue tail after update failure so later get, set, and clear succeed', async () => {
        workspace.reset({
            'fail-key': 'keep-after-failure',
            'clear-after-failure': 'remove',
            'read-key': 'readable',
        });
        let shouldFail = true;
        workspace.beforeUpdate = async (key) => {
            if (key === 'fail-key' && shouldFail) {
                shouldFail = false;
                throw new Error('memento update failed');
            }
        };

        const failedClear = workspaceState.clear(['fail-key']);
        const successfulClear = workspaceState.clear(['clear-after-failure']);

        await assert.rejects(failedClear, /memento update failed/);
        await successfulClear;
        assert.strictEqual(await workspaceState.get('read-key'), 'readable');

        await workspaceState.set('new-key', 'new-value');
        assert.strictEqual(await workspaceState.get('new-key'), 'new-value');
        await workspaceState.clear(['new-key']);
        assert.strictEqual(await workspaceState.get('new-key'), undefined);
    });

    test('holds the queue until every deletion settles when a clear partially fails', async () => {
        workspace.reset({
            'fail-fast': 'unused',
            'slow-delete': 'stale',
        });
        const gate = createGate();
        workspace.beforeUpdate = async (key, value) => {
            if (key === 'fail-fast' && value === undefined) {
                throw new Error('memento update failed');
            }
            if (key === 'slow-delete' && value === undefined) {
                gate.started.resolve();
                await gate.release.promise;
            }
        };

        const failedClear = workspaceState.clear(['fail-fast', 'slow-delete']);
        await gate.started.promise;

        // A later write is queued while the failing clear's slow deletion is still pending.
        const laterSet = workspaceState.set('slow-delete', 'written-later');

        // The queue must not advance past the clear until the slow deletion settles,
        // so the later write has not been applied yet.
        assert.strictEqual(workspace.values.get('slow-delete'), 'stale');

        gate.release.resolve();
        await assert.rejects(failedClear, /memento update failed/);
        await laterSet;

        // The later write wins because it was serialized strictly after the deletion settled;
        // it is not clobbered by a late in-flight deletion from the failed clear.
        assert.strictEqual(workspace.values.get('slow-delete'), 'written-later');
        assert.strictEqual(await workspaceState.get('slow-delete'), 'written-later');
        assert.deepStrictEqual(
            workspace.updates.filter((update) => update.key === 'slow-delete').map((update) => update.value),
            [undefined, 'written-later'],
        );
    });
});

interface TestMemento {
    readonly memento: Memento;
    readonly values: Map<string, unknown>;
    readonly updates: Array<{ key: string; value: unknown }>;
    beforeUpdate?: (key: string, value: unknown) => Promise<void>;
    reset(initial?: Record<string, unknown>): void;
}

function createMemento(): TestMemento {
    const values = new Map<string, unknown>();
    const updates: Array<{ key: string; value: unknown }> = [];
    const result: TestMemento = {
        memento: undefined as unknown as Memento,
        values,
        updates,
        reset: (initial = {}) => {
            values.clear();
            Object.entries(initial).forEach(([key, value]) => values.set(key, value));
            updates.splice(0, updates.length);
            result.beforeUpdate = undefined;
        },
    };
    const memento = {
        keys: () => Array.from(values.keys()),
        get: <T>(key: string, defaultValue?: T): T | undefined =>
            (values.has(key) ? values.get(key) : defaultValue) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => {
            await result.beforeUpdate?.(key, value);
            updates.push({ key, value });
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, value);
            }
        },
    } as Memento;
    (result as { memento: Memento }).memento = memento;
    return result;
}

function createGate(): {
    readonly started: { readonly promise: Promise<void>; resolve(): void };
    readonly release: { readonly promise: Promise<void>; resolve(): void };
} {
    return {
        started: createSignal(),
        release: createSignal(),
    };
}

function createSignal(): { readonly promise: Promise<void>; resolve(): void } {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: () => resolvePromise!(),
    };
}
