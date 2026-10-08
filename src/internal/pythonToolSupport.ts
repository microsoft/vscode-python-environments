// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationError, CancellationToken, Disposable, l10n, Uri } from 'vscode';
import * as path from 'path';
import { isSameOrParentPath, normalizePath } from '../common/utils/pathUtils';
import type { NativePythonEnvironmentKind, NativePythonFinder } from '../managers/common/nativePythonFinder';
import type {
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
} from '../types';

/** Built-in opt-in to noninteractive operations, independent of UI quickCreateConfig. */
export const pythonToolSupport = Symbol('pythonToolSupport');

export interface PythonToolOperation {
    readonly token: CancellationToken;
    readonly baseEnvironment?: PythonEnvironment;
    getGlobalEnvironments(): Promise<PythonEnvironment[]>;
    managePackages(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void>;
}

export interface EnvironmentToolSupport {
    initialize(): Promise<void>;
    canConfigure?(scope: Uri): Promise<boolean>;
    get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined>;
    getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]>;
    resolve(scope: Uri): Promise<PythonEnvironment | undefined>;
    resolveProject?(scope: Uri): Promise<PythonEnvironment | undefined>;
    create?(scope: Uri, operation: PythonToolOperation): Promise<PythonEnvironment>;
    set?(scope: Uri, environment: PythonEnvironment, token: CancellationToken): Promise<void>;
    describe?(environment: PythonEnvironment, token: CancellationToken): Promise<PythonEnvironment>;
}

export interface PackageToolSupport {
    manage(
        environment: PythonEnvironment,
        options: PackageManagementOptions,
        token: CancellationToken,
        scope: Uri,
    ): Promise<void>;
    getPackages(environment: PythonEnvironment, token: CancellationToken, scope: Uri): Promise<Package[]>;
}

export interface ToolEnvironmentManager extends EnvironmentManager {
    readonly [pythonToolSupport]: EnvironmentToolSupport;
}

export interface ToolPackageManager extends PackageManager {
    readonly [pythonToolSupport]: PackageToolSupport;
}

export function supportsEnvironmentTools(manager: EnvironmentManager): manager is ToolEnvironmentManager {
    return pythonToolSupport in manager;
}

export function supportsPackageTools(manager: PackageManager): manager is ToolPackageManager {
    return pythonToolSupport in manager;
}

export class PythonToolError extends Error {
    constructor(public readonly code: string, message: string, public readonly environment?: PythonEnvironment) {
        super(message);
        this.name = 'PythonToolError';
    }
}

/**
 * Resolves an existing cached environment associated with the closest containing project.
 * @param scope The file or project targeted by configuration.
 * @param kind The native environment kind owned by the requesting manager.
 * @param finder The shared, noninteractive discovery service.
 * @param resolve The manager's noninteractive interpreter resolver.
 * @returns The project's environment, or undefined when none was discovered.
 */
export async function resolveToolProjectEnvironment(
    scope: Uri,
    kind: NativePythonEnvironmentKind,
    finder: NativePythonFinder,
    resolve: (uri: Uri) => Promise<PythonEnvironment | undefined>,
): Promise<PythonEnvironment | undefined> {
    const matches = (await finder.refresh(false)).flatMap((info) =>
        !('tool' in info) &&
        info.kind === kind &&
        info.project &&
        info.prefix &&
        info.executable &&
        isSameOrParentPath(info.project, scope.fsPath)
            ? [{
                  project: normalizePath(path.resolve(info.project)),
                  prefix: normalizePath(path.resolve(info.prefix)),
                  executable: info.executable,
              }]
            : [],
    );
    const closest = matches.sort((a, b) => b.project.length - a.project.length)[0];
    if (!closest) {
        return undefined;
    }
    const candidates = new Map(
        matches.filter((info) => info.project === closest.project).map((info) => [info.prefix, info]),
    );
    if (candidates.size > 1) {
        throw new PythonToolError(
            'AMBIGUOUS_ENVIRONMENT',
            l10n.t(
                'Multiple {0} environments belong to {1}. Configure pythonPath with the exact interpreter to use.',
                kind,
                scope.fsPath,
            ),
        );
    }
    return resolve(Uri.file(closest.executable));
}

export function throwIfCancelled(token?: CancellationToken): void {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }
}

/** Waits cancellably; null disables the deadline when waiting behind an owned operation. */
export async function waitForToolRead<T>(
    promise: PromiseLike<T>,
    token: CancellationToken,
    timeoutMs: number | null = 30_000,
): Promise<T> {
    throwIfCancelled(token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: Disposable | undefined;
    try {
        const value = await new Promise<T>((resolve, reject) => {
            if (timeoutMs !== null) {
                timer = setTimeout(
                    () =>
                        reject(
                            new PythonToolError(
                                'NOT_READY',
                                l10n.t(
                                    'Python environment discovery did not finish in time. Retry after discovery completes.',
                                ),
                            ),
                        ),
                    timeoutMs,
                );
            }
            subscription = token.onCancellationRequested(() => reject(new CancellationError()));
            Promise.resolve(promise).then(resolve, reject);
            if (token.isCancellationRequested) {
                reject(new CancellationError());
            }
        });
        throwIfCancelled(token);
        return value;
    } finally {
        clearTimeout(timer);
        subscription?.dispose();
    }
}
