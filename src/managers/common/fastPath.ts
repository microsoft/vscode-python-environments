// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Uri } from 'vscode';
import { GetEnvironmentScope, PythonEnvironment } from '../../api';
import { traceError, traceWarn } from '../../common/logging';
import { createDeferred, Deferred } from '../../common/utils/deferred';

/**
 * Options for the fast-path resolution in manager.get().
 */
export interface FastPathOptions {
    /** The current _initialized deferred (may be undefined if init hasn't started). */
    initialized: Deferred<void> | undefined;
    /** The scope passed to get(). */
    scope: GetEnvironmentScope;
    /** Label for log messages, e.g. 'venv', 'conda'. */
    label: string;
    /** Gets the project fsPath for a given Uri scope. */
    getProjectFsPath: (scope: Uri) => string;
    /** Reads the persisted env path for a workspace fsPath. */
    getPersistedPath: (workspaceFsPath: string) => Promise<string | undefined>;
    /** Resolves a persisted path to a full PythonEnvironment. */
    resolve: (persistedPath: string) => Promise<PythonEnvironment | undefined>;
    /** Starts background initialization (full discovery). Returns a promise that completes when init is done. */
    startBackgroundInit: () => Promise<void> | Thenable<void>;
}

/**
 * Result from a successful fast-path resolution.
 */
export interface FastPathResult {
    /** The resolved environment. */
    env: PythonEnvironment;
    /** A new deferred if one was created (caller must assign to _initialized). */
    newDeferred?: Deferred<void>;
}

/**
 * Attempts fast-path resolution for manager.get(): if full initialization hasn't completed yet
 * and there's a persisted environment for the workspace, resolve it directly via nativeFinder
 * instead of waiting for full discovery.
 *
 * Returns the resolved environment (with an optional new deferred) if successful, or undefined
 * to fall through to the normal init path.
 */
export async function tryFastPathGet(opts: FastPathOptions): Promise<FastPathResult | undefined> {
    if ((!opts.initialized || !opts.initialized.completed) && opts.scope instanceof Uri) {
        const fsPath = opts.getProjectFsPath(opts.scope);
        const persistedPath = await opts.getPersistedPath(fsPath);

        if (persistedPath) {
            try {
                const resolved = await opts.resolve(persistedPath);
                if (resolved) {
                    let newDeferred: Deferred<void> | undefined;
                    // Ensure full init is running in background (may already be in progress)
                    if (!opts.initialized) {
                        newDeferred = createDeferred();
                        const deferred = newDeferred;
                        Promise.resolve(opts.startBackgroundInit()).then(
                            () => deferred.resolve(),
                            (err) => {
                                traceError(`[${opts.label}] Background initialization failed: ${err}`);
                                deferred.resolve();
                            },
                        );
                    }
                    return { env: resolved, newDeferred };
                }
            } catch (err) {
                traceWarn(
                    `[${opts.label}] Fast path resolve failed for '${persistedPath}', falling back to full init: ${err}`,
                );
            }
        }
    }
    return undefined;
}
