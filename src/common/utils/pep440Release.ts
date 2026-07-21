// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { clean as cleanPep440Version, explain as explainPep440Version } from '@renovatebot/pep440';

/**
 * Parse the release segments from a PEP 440 version string.
 *
 * Release segments are the dotted numeric components of a version, such as
 * `[3, 12, 4]` for `3.12.4`. Leading/trailing whitespace, a leading `v`, and
 * an epoch prefix are ignored. Pre-release, post-release, development, and
 * local-version suffixes are intentionally omitted.
 */
export function parseReleaseSegments(version: string): number[] | undefined {
    const normalized = cleanPep440Version(version);
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