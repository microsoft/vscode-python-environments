import { ENVS_EXTENSION_ID } from '../../common/constants';
import { getGlobalPersistentState, getWorkspacePersistentState } from '../../common/persistentState';

export const SYSTEM_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:system:WORKSPACE_SELECTED`;
export const SYSTEM_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:system:GLOBAL_SELECTED`;

export async function clearSystemEnvCache(): Promise<void> {
    const workspaceState = await getWorkspacePersistentState();
    // The global system-Python selection is mirrored into workspaceState (see
    // getSystemEnvForGlobal/setSystemEnvForGlobal) so that the cross-session
    // cache survives on fresh remotes where globalState is cold. Clear both
    // the workspace-scoped map and the mirrored global key here.
    await workspaceState.clear([SYSTEM_WORKSPACE_KEY, SYSTEM_GLOBAL_KEY]);
    const globalState = await getGlobalPersistentState();
    await globalState.clear([SYSTEM_GLOBAL_KEY]);
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
 * Returns the cached path of the discovered global system Python.
 *
 * Reads from `workspaceState` first and falls back to `globalState`. The
 * workspace layer is the primary cache because, in remote scenarios
 * (SSH / WSL / dev containers / codespaces), `context.globalState` is scoped
 * to the remote machine and starts empty on every fresh remote. The
 * workspaceState mirror survives across sessions of the same workspace
 * folder on the same remote, so the foreground env-selection fast path can
 * hit the cache without waiting on a full PET refresh. See PR #1455 and
 * the cross-session cache acceptance criteria.
 */
export async function getSystemEnvForGlobal(): Promise<string | undefined> {
    const workspaceState = await getWorkspacePersistentState();
    const workspaceValue = await workspaceState.get<string>(SYSTEM_GLOBAL_KEY);
    if (workspaceValue) {
        return workspaceValue;
    }
    const globalState = await getGlobalPersistentState();
    return await globalState.get<string>(SYSTEM_GLOBAL_KEY);
}

/**
 * Persists the cached path of the discovered global system Python.
 *
 * Writes to BOTH `workspaceState` and `globalState` so the cache survives a
 * cold `globalState` on remotes (see `getSystemEnvForGlobal` for context).
 * Passing `undefined` invalidates both layers, keeping stale-path cleanup
 * consistent.
 */
export async function setSystemEnvForGlobal(envPath: string | undefined): Promise<void> {
    const [workspaceState, globalState] = await Promise.all([
        getWorkspacePersistentState(),
        getGlobalPersistentState(),
    ]);
    await Promise.all([
        workspaceState.set(SYSTEM_GLOBAL_KEY, envPath),
        globalState.set(SYSTEM_GLOBAL_KEY, envPath),
    ]);
}
