// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Uri } from 'vscode';

import { traceError, traceVerbose } from '../common/logging';
import { tryGetWorkspacePersistentState } from '../common/persistentState';

/**
 * Storage key for the explicit selection made for the default (non-workspace) context.
 * The value is versioned so a future shape change can be detected and ignored safely.
 */
const DEFAULT_ENVIRONMENT_SELECTION_KEY = 'python-envs:defaultEnvironmentSelection';

const DEFAULT_ENVIRONMENT_SELECTION_VERSION = 1;

/**
 * Minimal, versioned description of an explicit default-context selection.
 *
 * Only the identity needed to re-resolve the selection through its owning manager is stored;
 * a full serialized `PythonEnvironment` is deliberately NOT persisted because it can become
 * stale (paths, versions, execution info) between sessions.
 */
export interface DefaultEnvironmentSelection {
    readonly version: number;
    /** Id of the environment manager that owns the selection. */
    readonly managerId: string;
    /** `Uri.toString()` of the environment path, used to re-resolve through the manager. */
    readonly environmentPath: string;
    /** Optional environment id hint, used only to disambiguate an exact match. */
    readonly environmentId?: string;
}

function isDefaultEnvironmentSelection(value: unknown): value is DefaultEnvironmentSelection {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<DefaultEnvironmentSelection>;
    return (
        candidate.version === DEFAULT_ENVIRONMENT_SELECTION_VERSION &&
        typeof candidate.managerId === 'string' &&
        candidate.managerId.length > 0 &&
        typeof candidate.environmentPath === 'string' &&
        candidate.environmentPath.length > 0 &&
        (candidate.environmentId === undefined || typeof candidate.environmentId === 'string')
    );
}

/**
 * Persists the explicit default-context selection.
 *
 * Storage is VS Code's workspace state, which is scoped to the window's workspace (including
 * an empty window). It is intentionally NOT a user/global setting: writing
 * `python-envs.defaultEnvManager` or a synthetic `python-envs.pythonProjects` entry would
 * change unrelated windows and future workspaces.
 *
 * @param selection The selection to store, or `undefined` to clear the stored selection.
 * @returns `true` when the state was written (or cleared), `false` when persistence failed.
 */
export async function saveDefaultEnvironmentSelection(
    selection: { managerId: string; environmentPath: Uri; environmentId?: string } | undefined,
): Promise<boolean> {
    try {
        const statePromise = tryGetWorkspacePersistentState();
        if (!statePromise) {
            traceVerbose('[defaultEnvironmentState] Persistent state is unavailable; selection is session-only.');
            return false;
        }
        const state = await statePromise;
        if (!selection) {
            await state.set<DefaultEnvironmentSelection | undefined>(DEFAULT_ENVIRONMENT_SELECTION_KEY, undefined);
            return true;
        }
        await state.set<DefaultEnvironmentSelection>(DEFAULT_ENVIRONMENT_SELECTION_KEY, {
            version: DEFAULT_ENVIRONMENT_SELECTION_VERSION,
            managerId: selection.managerId,
            environmentPath: selection.environmentPath.toString(),
            environmentId: selection.environmentId,
        });
        return true;
    } catch (error) {
        traceError('[defaultEnvironmentState] Failed to persist default environment selection', error);
        return false;
    }
}

/**
 * Reads the persisted default-context selection.
 *
 * @returns The stored selection, or `undefined` when nothing is stored or the stored value is
 * missing/corrupted/from an unknown version.
 */
export async function loadDefaultEnvironmentSelection(): Promise<DefaultEnvironmentSelection | undefined> {
    try {
        const statePromise = tryGetWorkspacePersistentState();
        if (!statePromise) {
            traceVerbose('[defaultEnvironmentState] Persistent state is unavailable; nothing to restore.');
            return undefined;
        }
        const state = await statePromise;
        const stored = await state.get<unknown>(DEFAULT_ENVIRONMENT_SELECTION_KEY);
        if (stored === undefined) {
            return undefined;
        }
        if (!isDefaultEnvironmentSelection(stored)) {
            traceVerbose('[defaultEnvironmentState] Ignoring unrecognized persisted default environment selection');
            return undefined;
        }
        return stored;
    } catch (error) {
        traceError('[defaultEnvironmentState] Failed to read default environment selection', error);
        return undefined;
    }
}
