// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { PythonEnvironment } from '../api';
import { matchesPythonVersion } from './inlineScriptMetadata';
import { traceWarn } from './logging';

/**
 * Pick the newest installed Python that can serve as a base interpreter for
 * a PEP 723 script. Returns `undefined` if no candidate is usable (the
 * caller is then expected to prompt for a uv install or surface an error).
 *
 * **Caller contract**: `installed` must contain only BASE interpreters
 * (system Pythons, pyenv-installed, uv-installed, conda `base`) — never
 * venvs / conda named envs / poetry / pipenv project envs. This function
 * does not filter derived envs out, and using one as a venv base produces
 * a nested or broken environment. `api.getEnvironments('global')` is the
 * right source (with the caveat that pipenv's `'global'` scope is known
 * to leak derived envs).
 */
export function pickCompatibleInterpreter(
    installed: ReadonlyArray<PythonEnvironment>,
    requiresPython: string | undefined,
): PythonEnvironment | undefined {
    const constraint = requiresPython && requiresPython.length > 0 ? requiresPython : undefined;
    const candidates = installed.filter((env) => isUsableBaseInterpreter(env, constraint));
    if (candidates.length === 0) {
        return undefined;
    }
    const sorted = [...candidates].sort((a, b) => compareVersionsDescending(a.version, b.version));
    return sorted[0];
}

/**
 * Extract a lower-bound version string from a PEP 440 `requires-python`
 * specifier, suitable as the `version` argument to `uv python install`.
 *
 * Examples:
 *   ">=3.13"          → "3.13"
 *   ">=3.11,<3.13"    → "3.11"   (tightest lower bound across clauses)
 *   "~=3.12.4"        → "3.12.4"
 *   "==3.12.*"        → "3.12"
 *   "==3.12.7"        → "3.12.7"
 *
 * Returns `undefined` for specifiers without a clean lower bound (`<3.13`,
 * `!=3.10`, `>3.12`, `===…`, illegal shapes like `~=3` or `>=3.*`). The
 * caller falls back to the uv default and re-verifies with
 * `matchesPythonVersion` after install.
 */
export function extractLowerBoundVersion(requiresPython: string | undefined): string | undefined {
    if (!requiresPython) {
        return undefined;
    }
    const clauses = requiresPython
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    if (clauses.length === 0) {
        return undefined;
    }

    let best: number[] | undefined;
    let bestStr: string | undefined;
    for (const clause of clauses) {
        const lb = lowerBoundForClause(clause);
        if (lb === undefined) {
            continue;
        }
        if (best === undefined || compareReleaseSegments(lb.segments, best) > 0) {
            best = lb.segments;
            bestStr = lb.display;
        }
    }
    return bestStr;
}

function isUsableBaseInterpreter(env: PythonEnvironment, requiresPython: string | undefined): boolean {
    if (env.error) {
        return false;
    }
    if (typeof env.version !== 'string' || env.version.length === 0) {
        return false;
    }
    if (parseLeadingMajor(env.version) !== 3) {
        return false;
    }
    if (requiresPython !== undefined && !matchesPythonVersion(requiresPython, env.version)) {
        return false;
    }
    return true;
}

function parseLeadingMajor(version: string): number | undefined {
    const m = version.match(/^\s*v?(\d+)/i);
    if (!m) {
        return undefined;
    }
    const n = Number.parseInt(m[1], 10);
    return Number.isNaN(n) ? undefined : n;
}

function parseReleaseSegments(version: string): number[] | undefined {
    const m = version.match(/^v?(\d+(?:\.\d+)*)/i);
    if (!m) {
        return undefined;
    }
    return m[1].split('.').map((s) => Number.parseInt(s, 10));
}

function compareReleaseSegments(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        if (av < bv) {
            return -1;
        }
        if (av > bv) {
            return 1;
        }
    }
    return 0;
}

function compareVersionsDescending(a: string, b: string): number {
    const aSeg = parseReleaseSegments(a);
    const bSeg = parseReleaseSegments(b);
    if (aSeg === undefined && bSeg === undefined) {
        return 0;
    }
    if (aSeg === undefined) {
        return 1;
    }
    if (bSeg === undefined) {
        return -1;
    }
    return compareReleaseSegments(bSeg, aSeg);
}

const CLAUSE_RE = /^(===|~=|==|!=|>=|<=|>|<)\s*(.+)$/;

interface LowerBound {
    readonly segments: number[];
    readonly display: string;
}

function lowerBoundForClause(clause: string): LowerBound | undefined {
    const m = clause.match(CLAUSE_RE);
    if (!m) {
        traceWarn(`inline-script interpreter: unrecognized requires-python clause: ${JSON.stringify(clause)}`);
        return undefined;
    }
    const op = m[1];
    const raw = m[2].trim();

    switch (op) {
        case '>=': {
            // Per PEP 440 wildcards are only legal with `==` / `!=`. Stay
            // consistent with matchesPythonVersion (which rejects `>=X.*`)
            // so we never hand uv a value the picker will then reject.
            if (raw.endsWith('.*')) {
                traceWarn(
                    `inline-script interpreter: wildcards are only valid with '==' / '!=': ${JSON.stringify(clause)}`,
                );
                return undefined;
            }
            const segments = parseReleaseSegments(raw);
            if (segments === undefined) {
                return undefined;
            }
            return { segments, display: segmentsToString(segments) };
        }
        case '==': {
            const literal = raw.endsWith('.*') ? raw.slice(0, -2) : raw;
            const segments = parseReleaseSegments(literal);
            if (segments === undefined) {
                return undefined;
            }
            return { segments, display: segmentsToString(segments) };
        }
        case '~=': {
            // PEP 440 requires at least two release segments and disallows
            // wildcards for `~=`. Both rejections mirror matchesPythonVersion.
            if (raw.endsWith('.*')) {
                traceWarn(
                    `inline-script interpreter: wildcards are only valid with '==' / '!=': ${JSON.stringify(clause)}`,
                );
                return undefined;
            }
            const segments = parseReleaseSegments(raw);
            if (segments === undefined) {
                return undefined;
            }
            if (segments.length < 2) {
                traceWarn(
                    `inline-script interpreter: '~=' requires at least two release segments: ${JSON.stringify(clause)}`,
                );
                return undefined;
            }
            return { segments, display: segmentsToString(segments) };
        }
        case '>':
        case '<':
        case '<=':
        case '!=':
        case '===':
            // No clean integer floor we can hand to `uv python install`.
            // Caller falls back to uv default and re-verifies post-install.
            return undefined;
        default:
            return undefined;
    }
}

function segmentsToString(segments: ReadonlyArray<number>): string {
    return segments.join('.');
}
