import { ExtensionContext, Memento } from 'vscode';
import { traceError } from './logging';
import { createDeferred, Deferred } from './utils/deferred';

export interface PersistentState {
    get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    clear(keys?: string[]): Promise<void>;
}

class PersistentStateImpl implements PersistentState {
    private clearing: Deferred<void>;

    constructor(private readonly momento: Memento) {
        this.clearing = createDeferred<void>();
        this.clearing.resolve();
    }

    async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
        await this.clearing.promise;
        if (defaultValue === undefined) {
            return this.momento.get<T>(key);
        }
        return this.momento.get<T>(key, defaultValue);
    }

    async set<T>(key: string, value: T): Promise<void> {
        await this.clearing.promise;
        await this.momento.update(key, value);

        const before = JSON.stringify(value);
        const after = JSON.stringify(await this.momento.get<T>(key));
        if (before !== after) {
            await this.momento.update(key, undefined);
            traceError('Error while updating state for key:', key);
        }
    }

    async clear(keys?: string[]): Promise<void> {
        if (this.clearing.completed) {
            const clearing = (this.clearing = createDeferred<void>());
            try {
                const _keys = keys ?? this.momento.keys();
                const results = await Promise.allSettled(
                    _keys.map((key) => this.momento.update(key, undefined)),
                );
                const failure = results.find((result) => result.status === 'rejected');
                if (failure?.status === 'rejected') {
                    throw failure.reason;
                }
            } finally {
                clearing.resolve();
            }
        }
        return this.clearing.promise;
    }
}

const _workspace = createDeferred<PersistentState>();
const _global = createDeferred<PersistentState>();

/** Creates a persistent-state wrapper for the provided VS Code Memento. */
export function createPersistentState(memento: Memento): PersistentState {
    return new PersistentStateImpl(memento);
}

export function setPersistentState(context: ExtensionContext): void {
    _workspace.resolve(createPersistentState(context.workspaceState));
    _global.resolve(createPersistentState(context.globalState));
}

export function getWorkspacePersistentState(): Promise<PersistentState> {
    return _workspace.promise;
}

export function getGlobalPersistentState(): Promise<PersistentState> {
    return _global.promise;
}

export async function clearPersistentState(): Promise<void> {
    const [workspace, global] = await Promise.all([_workspace.promise, _global.promise]);
    await Promise.all([workspace.clear(), global.clear()]);
    return undefined;
}
