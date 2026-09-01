// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { clean as cleanPep440Version, explain as explainPep440Version } from '@renovatebot/pep440';

/**
 * Convert a CPython `sys.version_info`-style version string to PEP 440.
 *
 * The native locator (`pet`) reports interpreter versions as
 * `major.minor.micro.releaselevel.serial` — for example `"3.14.3.final.0"` or
 * `"3.14.0.candidate.2"`. That shape is **not** valid PEP 440, so the
 * `@renovatebot/pep440` helpers (`clean`, `satisfies`, …) reject it. This maps
 * it to the PEP 440 equivalent (`"3.14.3"`, `"3.14.0rc2"`).
 *
 * The numeric release segments are preserved verbatim (no zero-padding, so
 * `"3.14"` is never rewritten to `"3.14.0"`), and any string that does not
 * match the `sys.version_info` shape is returned unchanged.
 */
export function normalizeCpythonVersionInfo(version: string): string {
    const match = /^(\d+(?:\.\d+)*)\.(alpha|beta|candidate|final)\.(\d+)$/i.exec(version.trim());
    if (!match) {
        return version;
    }
    const [, release, level, serial] = match;
    switch (level.toLowerCase()) {
        case 'alpha':
            return `${release}a${serial}`;
        case 'beta':
            return `${release}b${serial}`;
        case 'candidate':
            return `${release}rc${serial}`;
        case 'final':
        default:
            return release;
    }
}

/**
 * Parse the release segments from a PEP 440 version string.
 *
 * Release segments are the dotted numeric components of a version, such as
 * `[3, 12, 4]` for `3.12.4`. Leading/trailing whitespace, a leading `v`, and
 * an epoch prefix are ignored. Pre-release, post-release, development, and
 * local-version suffixes are intentionally omitted. CPython `sys.version_info`
 * strings (e.g. `"3.14.3.final.0"`) are normalized via
 * {@link normalizeCpythonVersionInfo} before parsing.
 */
export function parseReleaseSegments(version: string): number[] | undefined {
    const normalized = cleanPep440Version(normalizeCpythonVersionInfo(version));
    return normalized ? (explainPep440Version(normalized)?.release ?? undefined) : undefined;
}

/**
 * Compare two PEP 440 release-segment arrays numerically.
 *
 * Missing trailing segments are treated as zero, so `3.12` and `3.12.0`
 * compare as equal. Returns a negative number when `left` is older, zero when
 * they are equal, and a positive number when `left` is newer.
 */
export function compareReleaseSegments(left: readonly number[], right: readonly number[]): number {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const leftSegment = left[index] ?? 0;
        const rightSegment = right[index] ?? 0;
        if (leftSegment < rightSegment) {
            return -1;
        }
        if (leftSegment > rightSegment) {
            return 1;
        }
    }
    return 0;
}