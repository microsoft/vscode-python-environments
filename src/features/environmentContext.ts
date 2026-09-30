// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Uri } from 'vscode';

import { normalizePath } from '../common/utils/pathUtils';

/**
 * Logical selection context for an environment scope.
 *
 * - `default`: the rootless context shared by ordinary loose files (files opened without a
 *   workspace/folder, or files that live outside every tracked Python project). There is no
 *   filesystem root and no synthetic `PythonProject` behind it; it maps to `undefined` at the
 *   manager and public API boundary.
 * - `project`: a tracked Python project identified by its project URI.
 * - `script`: an existing per-script (inline-script) association identified by the script URI.
 */
export type EnvironmentContext =
    | { readonly kind: 'default' }
    | { readonly kind: 'project'; readonly uri: Uri }
    | { readonly kind: 'script'; readonly uri: Uri };

/** Stable selection-cache key used for the default (non-workspace) context. */
export const DEFAULT_CONTEXT_KEY = 'global';

export const DEFAULT_CONTEXT: EnvironmentContext = { kind: 'default' };

/**
 * URI schemes that may represent an ordinary loose file. Anything else (notebook cells,
 * virtual/provider-backed documents, ...) keeps its existing routing untouched instead of
 * being silently normalized into the default context.
 */
const ORDINARY_FILE_SCHEMES = new Set(['file', 'untitled']);

/**
 * Returns true when the URI may be treated as an ordinary loose file, i.e. a document that
 * can share the default context with other non-workspace files.
 */
export function isOrdinaryFileScheme(uri: Uri): boolean {
    return ORDINARY_FILE_SCHEMES.has(uri.scheme);
}

/** Returns the scope to hand to an environment manager / the public API for a context. */
export function contextToScope(context: EnvironmentContext): Uri | undefined {
    return context.kind === 'default' ? undefined : context.uri;
}

/** Returns the stable selection-cache key for a context. */
export function contextKey(context: EnvironmentContext): string {
    switch (context.kind) {
        case 'default':
            return DEFAULT_CONTEXT_KEY;
        case 'project':
            return context.uri.toString();
        case 'script':
            return `inline-script:${normalizePath(context.uri.fsPath)}`;
    }
}

/** True when two contexts target the same selection. */
export function isSameContext(first: EnvironmentContext, second: EnvironmentContext): boolean {
    return contextKey(first) === contextKey(second);
}
