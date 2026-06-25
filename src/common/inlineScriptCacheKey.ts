// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { createHash } from 'crypto';
import { normalizePath } from './utils/pathUtils';

/** Length, in hex chars, of the cache key returned by {@link computeCacheKey}. 16 = 64 bits of SHA-256; fixed-length and filesystem-safe. */
export const CACHE_KEY_HEX_LENGTH = 16;

/**
 * Inputs that participate in the cache key.
 *
 * **Caller contract**: `interpreterPath` must be an absolute path that the
 * caller has already resolved through symlinks (e.g. via `fs.realpath()`).
 * This function does no I/O. Two string-distinct paths that point to the
 * same physical executable will produce two different cache keys.
 */
export interface CacheKeyInputs {
    readonly dependencies: readonly string[];
    readonly interpreterPath: string;
}

function normalizePep503Name(name: string): string {
    return name.replace(/[-_.]+/g, '-').toLowerCase();
}

function normalizeExtras(inner: string): string {
    const items = inner
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
        .map((e) => normalizePep503Name(e));
    const deduped = Array.from(new Set(items)).sort();
    return deduped.length > 0 ? `[${deduped.join(',')}]` : '';
}

/**
 * Canonicalize a PEP 723 dependency entry so common variants of the same
 * requirement produce identical strings. Not a full PEP 508 parser — only
 * folds the superficial edits users are likely to make:
 *
 *   "Requests"                       → "requests"
 *   "Flask-Login"                    → "flask-login"
 *   "requests <3"                    → "requests<3"
 *   "requests <3, !=2.0"             → "requests<3,!=2.0"
 *   "Requests[Security,Socks]"       → "requests[security,socks]"
 *   "requests[socks,security]"       → "requests[security,socks]"
 *   "requests[security,Security]"    → "requests[security]"
 *
 * Extras (per PEP 503) are lowercased, separator-folded ([._-]+ → -),
 * deduplicated, and sorted alphabetically — same canonical form pip and
 * uv use for the project name, applied to each extra.
 */
export function normalizeDependency(dep: string): string {
    const trimmed = dep.trim();
    if (trimmed.length === 0) {
        return '';
    }

    const nameMatch = trimmed.match(/^[A-Za-z0-9_.-]+/);
    if (!nameMatch) {
        // URL/VCS spec or other malformed entry — return trimmed so the
        // hash stays deterministic without pretending to parse it.
        return trimmed;
    }
    const name = normalizePep503Name(nameMatch[0]);
    let rest = trimmed.slice(nameMatch[0].length);

    let extras = '';
    const extrasMatch = rest.match(/^\s*\[([^\]]*)\]/);
    if (extrasMatch) {
        extras = normalizeExtras(extrasMatch[1]);
        rest = rest.slice(extrasMatch[0].length);
    }

    const compactedRest = rest
        .replace(/\s+/g, ' ')
        .replace(/\s*([<>=!~]=?)\s*/g, '$1')
        .trim();

    return `${name}${extras}${compactedRest}`;
}

export function normalizeInterpreterPath(interpreterPath: string): string {
    return normalizePath(interpreterPath);
}

/**
 * Compute the deterministic cache key for an inline-script env. The
 * payload uses a versioned, labelled-line shape — any future hashed input
 * MUST extend this shape rather than appending a new separator, or
 * existing hashes break silently.
 */
export function computeCacheKey(inputs: CacheKeyInputs): string {
    const normalizedDeps = Array.from(
        new Set(inputs.dependencies.map((d) => normalizeDependency(d)).filter((d) => d.length > 0)),
    ).sort();
    const normalizedInterpreter = normalizeInterpreterPath(inputs.interpreterPath);

    const payload = ['v1', `interpreter=${normalizedInterpreter}`, `deps=${normalizedDeps.join('\n  ')}`].join('\n');

    return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, CACHE_KEY_HEX_LENGTH);
}
