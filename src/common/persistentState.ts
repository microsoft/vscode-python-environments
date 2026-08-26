import { ExtensionContext, Memento } from 'vscode';
import { traceError } from './logging';
import { createDeferred, Deferred } from './utils/deferred';

export interface PersistentState {
    get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    clear(keys?: string[], options?: { readonly preserveKeys?: readonly string[] }): Promise<void>;
}

export interface ClearPersistentStateOptions {
    readonly preserveWorkspaceKeys?: readonly string[];
    readonly preserveGlobalKeys?: readonly string[];
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
    async clear(keys?: string[], options?: { readonly preserveKeys?: readonly string[] }): Promise<void> {
        if (this.clearing.completed) {
            this.clearing = createDeferred<void>();
            const preservedKeys = new Set(options?.preserveKeys ?? []);
            const _keys = (keys ?? this.momento.keys()).filter((key) => !preservedKeys.has(key));
            await Promise.all(_keys.map((key) => this.momento.update(key, undefined)));
            this.clearing.resolve();
        }
        return this.clearing.promise;
    }
}

const _workspace = createDeferred<PersistentState>();
const _global = createDeferred<PersistentState>();

export function setPersistentState(context: ExtensionContext): void {
    _workspace.resolve(new PersistentStateImpl(context.workspaceState));
    _global.resolve(new PersistentStateImpl(context.globalState));
}

export function getWorkspacePersistentState(): Promise<PersistentState> {
    return _workspace.promise;
}

export function getGlobalPersistentState(): Promise<PersistentState> {
    return _global.promise;
}

export async function clearPersistentState(options?: ClearPersistentStateOptions): Promise<void> {
    const [workspace, global] = await Promise.all([_workspace.promise, _global.promise]);
    await Promise.all([
        workspace.clear(undefined, { preserveKeys: options?.preserveWorkspaceKeys }),
        global.clear(undefined, { preserveKeys: options?.preserveGlobalKeys }),
    ]);
    return undefined;
}
