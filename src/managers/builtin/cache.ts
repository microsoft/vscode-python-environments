import { randomUUID } from 'crypto';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { traceError } from '../../common/logging';
import {
    getGlobalPersistentState,
    getWorkspacePersistentState,
    type PersistentState,
} from '../../common/persistentState';

export const SYSTEM_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:system:WORKSPACE_SELECTED`;
export const SYSTEM_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:system:GLOBAL_SELECTED`;
export const SYSTEM_GLOBAL_REVISION_KEY = `${SYSTEM_GLOBAL_KEY}:REVISION`;

type CacheLayer = 'globalState' | 'workspaceState';
type CacheOperationResult = { succeeded: true } | { succeeded: false; error: unknown };

interface GlobalSelectionCacheEntry {
    readonly path?: string;
    readonly revision: string;
}

interface WorkspaceGlobalSelection {
    readonly selection?: unknown;
    readonly revision?: string;
    readonly failed: boolean;
}

let globalCacheMutation: Promise<void> = Promise.resolve();

function enqueueGlobalCacheMutation(operation: () => Promise<void>): Promise<void> {
    const result = globalCacheMutation.then(operation, operation);
    globalCacheMutation = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function isGlobalSelectionCacheEntry(value: unknown): value is GlobalSelectionCacheEntry {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const entry = value as { path?: unknown; revision?: unknown };
    return (
        typeof entry.revision === 'string' &&
        entry.revision.length > 0 &&
        (entry.path === undefined || typeof entry.path === 'string')
    );
}

function hasStoredGlobalSelection(value: unknown): boolean {
    return (typeof value === 'string' && value.length > 0) || isGlobalSelectionCacheEntry(value);
}

function getStoredGlobalSelectionPath(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value || undefined;
    }
    return isGlobalSelectionCacheEntry(value) ? value.path : undefined;
}

function isCurrentWorkspaceSelection(selection: unknown, revision: string | undefined): boolean {
    if (typeof selection === 'string') {
        return selection.length > 0 && revision === undefined;
    }
    return isGlobalSelectionCacheEntry(selection) && (revision === undefined || selection.revision === revision);
}

async function readWorkspaceGlobalSelection(): Promise<WorkspaceGlobalSelection> {
    try {
        const state = await getWorkspacePersistentState();
        const [selection, revision] = await Promise.all([
            state.get<unknown>(SYSTEM_GLOBAL_KEY),
            state.get<string>(SYSTEM_GLOBAL_REVISION_KEY),
        ]);
        return { selection, revision, failed: false };
    } catch (error) {
        traceError('Failed to read workspaceState system Python cache:', error);
        return { failed: true };
    }
}

async function readGlobalSelection(): Promise<unknown> {
    try {
        const state = await getGlobalPersistentState();
        return await state.get<unknown>(SYSTEM_GLOBAL_KEY);
    } catch (error) {
        traceError('Failed to read globalState system Python cache:', error);
        return undefined;
    }
}

async function runCacheOperation(
    operation: 'clear' | 'invalidate' | 'update',
    layer: CacheLayer,
    action: () => Promise<void>,
): Promise<CacheOperationResult> {
    try {
        await action();
        return { succeeded: true };
    } catch (error) {
        traceError(`Failed to ${operation} ${layer} system Python cache:`, error);
        return { succeeded: false, error };
    }
}

/**
 * Clears system Python selections from workspace and global persistent state.
 * Both layers are attempted before the first failure is rethrown.
 */
export function clearSystemEnvCache(): Promise<void> {
    return enqueueGlobalCacheMutation(async () => {
        const results = await Promise.all([
            runCacheOperation('clear', 'workspaceState', async () => {
                const state = await getWorkspacePersistentState();
                await state.clear([SYSTEM_WORKSPACE_KEY, SYSTEM_GLOBAL_KEY, SYSTEM_GLOBAL_REVISION_KEY]);
            }),
            runCacheOperation('clear', 'globalState', async () => {
                const state = await getGlobalPersistentState();
                await state.clear([SYSTEM_GLOBAL_KEY]);
            }),
        ]);
        const failure = results.find((result) => !result.succeeded);
        if (failure && !failure.succeeded) {
            throw failure.error;
        }
    });
}

export async function getSystemEnvForWorkspace(fsPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(SYSTEM_WORKSPACE_KEY);
    if (data) {
        try {
            return data[fsPath];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setSystemEnvForWorkspace(fsPath: string, envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(SYSTEM_WORKSPACE_KEY)) ?? {};
    if (envPath) {
        data[fsPath] = envPath;
    } else {
        delete data[fsPath];
    }
    await state.set(SYSTEM_WORKSPACE_KEY, data);
}

export async function setSystemEnvForWorkspaces(fsPath: string[], envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(SYSTEM_WORKSPACE_KEY)) ?? {};
    fsPath.forEach((s) => {
        if (envPath) {
            data[s] = envPath;
        } else {
            delete data[s];
        }
    });
    await state.set(SYSTEM_WORKSPACE_KEY, data);
}

/**
 * Returns the persisted global system Python path.
 *
 * A complete `workspaceState` entry is primary so the last system Python
 * resolved for this workspace survives a cold remote `globalState`. The global
 * entry is read only for legacy cold caches or to recover an incomplete mirrored
 * write identified by the workspace revision marker.
 */
export async function getSystemEnvForGlobal(): Promise<string | undefined> {
    await globalCacheMutation;
    const workspace = await readWorkspaceGlobalSelection();
    if (!workspace.failed && isCurrentWorkspaceSelection(workspace.selection, workspace.revision)) {
        return getStoredGlobalSelectionPath(workspace.selection);
    }

    const globalSelection = await readGlobalSelection();
    if (
        workspace.revision &&
        isGlobalSelectionCacheEntry(globalSelection) &&
        globalSelection.revision === workspace.revision
    ) {
        return globalSelection.path;
    }
    if (hasStoredGlobalSelection(workspace.selection)) {
        return getStoredGlobalSelectionPath(workspace.selection);
    }
    return getStoredGlobalSelectionPath(globalSelection);
}

/**
 * Removes a stale global system Python path without overwriting a newer selection.
 * Each layer is compared and updated independently inside the mutation queue.
 */
export function invalidateSystemEnvForGlobal(stalePath: string): Promise<void> {
    return enqueueGlobalCacheMutation(async () => {
        await Promise.all([
            runCacheOperation('invalidate', 'workspaceState', async () => {
                const state = await getWorkspacePersistentState();
                const selection = await state.get<unknown>(SYSTEM_GLOBAL_KEY);
                if (getStoredGlobalSelectionPath(selection) === stalePath) {
                    await state.set(SYSTEM_GLOBAL_KEY, undefined);
                }
            }),
            runCacheOperation('invalidate', 'globalState', async () => {
                const state = await getGlobalPersistentState();
                const selection = await state.get<unknown>(SYSTEM_GLOBAL_KEY);
                if (getStoredGlobalSelectionPath(selection) === stalePath) {
                    await state.set(SYSTEM_GLOBAL_KEY, undefined);
                }
            }),
        ]);
    });
}

/**
 * Persists the global system Python path in both global and workspace state.
 *
 * Each write is best-effort and independent so a failure in one storage layer
 * cannot block discovery or prevent the other layer from being updated. An
 * `undefined` path is persisted as a tombstone so a failed mirror deletion cannot
 * resurrect an older fallback value.
 */
export function setSystemEnvForGlobal(envPath: string | undefined): Promise<void> {
    return enqueueGlobalCacheMutation(async () => {
        const revision = randomUUID();
        const selection: GlobalSelectionCacheEntry = { path: envPath, revision };
        let workspaceState: PersistentState | undefined;
        try {
            workspaceState = await getWorkspacePersistentState();
            await workspaceState.set(SYSTEM_GLOBAL_REVISION_KEY, revision);
        } catch (error) {
            traceError('Failed to prepare workspaceState system Python cache update:', error);
        }

        await Promise.all([
            runCacheOperation('update', 'workspaceState', async () => {
                const state = workspaceState ?? (await getWorkspacePersistentState());
                await state.set(SYSTEM_GLOBAL_KEY, selection);
            }),
            runCacheOperation('update', 'globalState', async () => {
                const state = await getGlobalPersistentState();
                await state.set(SYSTEM_GLOBAL_KEY, selection);
            }),
        ]);
    });
}
