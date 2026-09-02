// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { PythonEnvironment } from '../../api';
import { traceWarn } from '../logging';
import { PythonVersion } from '../pythonVersion';
import { splitClause } from '../pythonVersionSpecifier';
import { matchesPythonVersion } from './metadata';

/**
 * Pick the newest installed Python that can serve as a base interpreter for
 * a PEP 723 script. Returns `undefined` if no candidate is usable. This
 * result is not user consent to install anything: the caller must use the
 * consent-gated uv install prompt or surface an actionable error.
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
    const trimmedConstraint = requiresPython?.trim();
    const constraint = trimmedConstraint ? trimmedConstraint : undefined;
    const candidates = installed.flatMap((env) => {
        const version = isUsableBaseInterpreter(env, constraint) ? PythonVersion.tryParse(env.version) : undefined;
        return version ? [{ env, version }] : [];
    });
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates.sort((a, b) => b.version.compareTo(a.version))[0].env;
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

    let best: PythonVersion | undefined;
    let bestStr: string | undefined;
    for (const clause of clauses) {
        const lb = lowerBoundForClause(clause);
        if (lb === undefined) {
            continue;
        }
        if (best === undefined || lb.version.compareTo(best) > 0) {
            best = lb.version;
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
    if (PythonVersion.tryParse(env.version)?.major !== 3) {
        return false;
    }
    if (requiresPython !== undefined && !matchesPythonVersion(requiresPython, env.version)) {
        return false;
    }
    return true;
}

interface LowerBound {
    readonly version: PythonVersion;
    readonly display: string;
}

function lowerBoundForClause(clause: string): LowerBound | undefined {
    const parts = splitClause(clause);
    if (!parts) {
        traceWarn(`inline-script interpreter: unrecognized requires-python clause: ${JSON.stringify(clause)}`);
        return undefined;
    }
    const { operator, literal } = parts;

    // Only the operators that establish a floor yield an install target. The
    // rest leave no clean integer floor for `uv python install`, so the caller
    // falls back to the uv default and re-verifies after installing.
    if (operator !== '>=' && operator !== '==' && operator !== '~=') {
        return undefined;
    }

    // Per PEP 440 wildcards are only legal with `==` / `!=`. Stay consistent
    // with matchesPythonVersion (which rejects `>=X.*`) so we never hand uv a
    // value the picker will then reject.
    if (literal.endsWith('.*') && operator !== '==') {
        traceWarn(`inline-script interpreter: wildcards are only valid with '==' / '!=': ${JSON.stringify(clause)}`);
        return undefined;
    }

    const version = PythonVersion.tryParse(literal.endsWith('.*') ? literal.slice(0, -2) : literal);
    if (!version) {
        return undefined;
    }

    // PEP 440 requires at least two release segments for `~=`, mirroring
    // matchesPythonVersion.
    if (operator === '~=' && version.precision < 2) {
        traceWarn(`inline-script interpreter: '~=' requires at least two release segments: ${JSON.stringify(clause)}`);
        return undefined;
    }

    return { version, display: version.toReleaseString() };
}
