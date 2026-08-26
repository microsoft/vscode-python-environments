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

    test('completes a dedicated inline key deletion and a concurrent generic preserve-clear without dropping either', async () => {
        workspace.reset({
            [INLINE_SCRIPT_ENVS_KEY]: { script: 'environment' },
            'other-workspace-key': 'remove',
        });
        global.reset({ 'other-global-key': 'remove' });

        const gate = createGate();
        workspace.beforeUpdate = async (key) => {
            if (key === 'other-workspace-key') {
                gate.started.resolve();
                await gate.release.promise;
            }
        };

        // The generic Clear Cache preserves the inline association key while clearing
        // everything else. Hold it mid-flight...
        const genericClear = clearPersistentState({ preserveWorkspaceKeys: [INLINE_SCRIPT_ENVS_KEY] });
        await gate.started.promise;

        // ...then issue the dedicated inline deletion (a direct set to undefined, the same
        // call the inline manager makes). A clear([key]) here would coalesce onto the
        // in-flight generic clear and be dropped; a set is never coalesced.
        const dedicatedDelete = workspaceState.set(INLINE_SCRIPT_ENVS_KEY, undefined);

        gate.release.resolve();
        await Promise.all([genericClear, dedicatedDelete]);

        // Neither operation was dropped: the generic clear removed every non-inline key and
        // the dedicated deletion removed the inline key.
        assert.strictEqual(workspace.values.has('other-workspace-key'), false);
        assert.strictEqual(global.values.has('other-global-key'), false);
        assert.strictEqual(workspace.values.has(INLINE_SCRIPT_ENVS_KEY), false);
    });

    test('clears every key by default, matching the pre-refactor implementation', async () => {
        workspace.reset({
            'workspace-key-a': 'a',
            'workspace-key-b': 'b',
            [INLINE_SCRIPT_ENVS_KEY]: { script: 'environment' },
        });

        await workspaceState.clear();

        assert.strictEqual(workspace.values.size, 0);
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
