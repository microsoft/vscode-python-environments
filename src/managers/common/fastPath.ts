// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Uri } from 'vscode';
import { GetEnvironmentScope, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { traceError, traceVerbose, traceWarn } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred, Deferred } from '../../common/utils/deferred';

/**
 * Options for the fast-path resolution in manager.get().
 */
export interface FastPathOptions {
    /** The current _initialized deferred (may be undefined if init hasn't started). */
    initialized: Deferred<void> | undefined;
    /** Updates the manager's _initialized deferred. */
    setInitialized: (initialized: Deferred<void> | undefined) => void;
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
    /** Optional: reads the persisted env path for global scope (when scope is undefined). */
    getGlobalPersistedPath?: () => Promise<string | undefined>;
}

/**
 * Result from a successful fast-path resolution.
 */
export interface FastPathResult {
    /** The resolved environment. */
    env: PythonEnvironment;
}

/**
 * Gets the fsPath for a scope by preferring the resolved project path when available.
 */
export function getProjectFsPathForScope(api: Pick<PythonEnvironmentApi, 'getPythonProject'>, scope: Uri): string {
    return api.getPythonProject(scope)?.uri.fsPath ?? scope.fsPath;
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
    const isGlobalScope = !(opts.scope instanceof Uri);

    // Global scope is only supported when the caller provides getGlobalPersistedPath
    if (isGlobalScope && !opts.getGlobalPersistedPath) {
        return undefined;
    }

    if (opts.initialized?.completed) {
        return undefined;
    }

    let deferred = opts.initialized;
    if (!deferred) {
        deferred = createDeferred<void>();
        opts.setInitialized(deferred);
        const deferredRef = deferred;
        try {
            Promise.resolve(opts.startBackgroundInit()).then(
                () => deferredRef.resolve(),
                (err) => {
                    traceError(`[${opts.label}] Background initialization failed:`, err);
                    // Allow subsequent get()/initialize() calls to retry after a background init failure.
                    opts.setInitialized(undefined);
                    deferredRef.resolve();
                },
            );
        } catch (syncErr) {
            traceError(`[${opts.label}] Background initialization threw synchronously:`, syncErr);
            opts.setInitialized(undefined);
            deferredRef.resolve();
        }
    }

    // Look up the persisted path — either from workspace cache or global cache
    if (isGlobalScope) {
        // Safe: guarded by the early return above
        const getGlobalPersistedPath = opts.getGlobalPersistedPath as () => Promise<string | undefined>;

        // Track end-to-end cross-session cache performance for global scope, including persisted-path lookup.
        const cacheStopWatch = new StopWatch();
        const persistedPath = await getGlobalPersistedPath();

        if (persistedPath) {
            try {
                const resolved = await opts.resolve(persistedPath);
                if (resolved) {
                    sendTelemetryEvent(EventNames.GLOBAL_ENV_CACHE, cacheStopWatch.elapsedTime, {
                        managerLabel: opts.label,
                        result: 'hit',
                    });
                    return { env: resolved };
                }
                // Cached path found but resolve returned undefined (e.g., Python was uninstalled)
                sendTelemetryEvent(EventNames.GLOBAL_ENV_CACHE, cacheStopWatch.elapsedTime, {
                    managerLabel: opts.label,
                    result: 'stale',
                });
            } catch (err) {
                sendTelemetryEvent(EventNames.GLOBAL_ENV_CACHE, cacheStopWatch.elapsedTime, {
                    managerLabel: opts.label,
                    result: 'stale',
                });
                traceWarn(
                    `[${opts.label}] Fast path resolve failed for '${persistedPath}', falling back to full init:`,
                    err,
                );
            }
        } else {
            sendTelemetryEvent(EventNames.GLOBAL_ENV_CACHE, cacheStopWatch.elapsedTime, {
                managerLabel: opts.label,
                result: 'miss',
            });
            traceVerbose(`[${opts.label}] Fast path: no persisted path, falling through to slow path`);
        }
    } else {
        const scope = opts.scope as Uri;
        const persistedPath = await opts.getPersistedPath(opts.getProjectFsPath(scope));

        if (persistedPath) {
            try {
                const resolved = await opts.resolve(persistedPath);
                if (resolved) {
                    return { env: resolved };
                }
            } catch (err) {
                traceWarn(
                    `[${opts.label}] Fast path resolve failed for '${persistedPath}', falling back to full init:`,
                    err,
                );
            }
        } else {
            traceVerbose(`[${opts.label}] Fast path: no persisted path, falling through to slow path`);
        }
    }

    return undefined;
}
