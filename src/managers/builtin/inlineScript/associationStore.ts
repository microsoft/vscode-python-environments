// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Memento } from 'vscode';
import { INLINE_SCRIPT_ENVS_KEY } from '../../../common/constants';
import { traceError } from '../../../common/logging';

/**
 * Accessor bound to the single inline-script association key ({@link INLINE_SCRIPT_ENVS_KEY}).
 *
 * It is handed to callers inside a serialized {@link InlineScriptAssociationStore.runExclusive}
 * transaction so a read and its dependent write execute as one atomic queue entry. Callers must
 * only use it within the transaction they were given it in — enqueuing another store operation
 * from inside a transaction would deadlock the queue on itself.
 */
export interface InlineAssociationAccessor {
    /** Raw read of the association key. */
    get<T>(): Promise<T | undefined>;
    /**
     * Verified write of the association key. Mirrors `PersistentState.set`: after the update it
     * reads the value back and, on a JSON mismatch, clears the key and logs. A rejected update
     * propagates to the caller.
     */
    update<T>(value: T): Promise<void>;
}

/**
 * Inline-script-owned persistence for PEP 723 script-to-environment associations.
 *
 * The store owns exactly one workspace-state key ({@link INLINE_SCRIPT_ENVS_KEY}) and never
 * exposes arbitrary keys. Every high-level read/mutation/deletion runs on an internal
 * failure-isolated FIFO queue: operations execute in invocation order, each caller receives its
 * own operation's success or failure, and a rejected operation still advances the queue so later
 * operations run.
 *
 * The store depends only on the injected {@link Memento}; it never touches the shared
 * `PersistentState` clear gate, so a wedged generic "Clear Cache" cannot block inline association
 * work, and a dedicated inline deletion cannot be coalesced onto (and dropped by) a generic clear.
 */
export class InlineScriptAssociationStore {
    private tail: Promise<void> = Promise.resolve();
    private readonly accessor: InlineAssociationAccessor;

    constructor(private readonly memento: Memento) {
        this.accessor = {
            get: async <T>(): Promise<T | undefined> => this.memento.get<T>(INLINE_SCRIPT_ENVS_KEY),
            update: async <T>(value: T): Promise<void> => {
                await this.memento.update(INLINE_SCRIPT_ENVS_KEY, value);
                const before = JSON.stringify(value);
                const after = JSON.stringify(await this.memento.get<T>(INLINE_SCRIPT_ENVS_KEY));
                if (before !== after) {
                    await this.memento.update(INLINE_SCRIPT_ENVS_KEY, undefined);
                    traceError('Error while updating state for key:', INLINE_SCRIPT_ENVS_KEY);
                }
            },
        };
    }

    /**
     * Serialize `operation` on the FIFO queue. The operation receives an accessor bound to the
     * single association key so it can perform a read-modify-write as one atomic transaction. The
     * caller receives the operation's own result or rejection; a rejection still advances the
     * queue tail so subsequent operations run.
     */
    runExclusive<T>(operation: (state: InlineAssociationAccessor) => Promise<T>): Promise<T> {
        const run = this.tail.then(() => operation(this.accessor));
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Queued raw read of the association key. */
    read<T>(): Promise<T | undefined> {
        return this.runExclusive((state) => state.get<T>());
    }

    /**
     * Queued dedicated deletion of the association key via a direct key update to `undefined`.
     *
     * Because this is an ordinary queued write on the inline-owned queue (never a shared
     * `PersistentState.clear`), it cannot be coalesced onto an in-flight generic clear and then
     * dropped; it runs strictly in invocation order and always writes.
     */
    clear(): Promise<void> {
        return this.runExclusive((state) => state.update(undefined));
    }
}
