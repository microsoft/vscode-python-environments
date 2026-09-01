// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import {
    compareReleaseSegments,
    normalizeCpythonVersionInfo,
    parseReleaseSegments,
} from '../../../common/utils/pep440Release';

suite('pep440Release', () => {
    suite('normalizeCpythonVersionInfo', () => {
        test('rewrites a final sys.version_info string to its release', () => {
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.3.final.0'), '3.14.3');
        });

        test('rewrites prerelease sys.version_info strings to PEP 440 prereleases', () => {
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.0.alpha.1'), '3.14.0a1');
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.0.beta.2'), '3.14.0b2');
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.0.candidate.3'), '3.14.0rc3');
        });

        test('trims surrounding whitespace before matching', () => {
            assert.strictEqual(normalizeCpythonVersionInfo('  3.14.3.final.0  '), '3.14.3');
        });

        test('does not zero-pad the release segments', () => {
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.final.0'), '3.14');
        });

        test('returns non-version_info strings unchanged', () => {
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.3'), '3.14.3');
            assert.strictEqual(normalizeCpythonVersionInfo('3.13'), '3.13');
            assert.strictEqual(normalizeCpythonVersionInfo('3.14.0rc2'), '3.14.0rc2');
            assert.strictEqual(normalizeCpythonVersionInfo('>=3.11'), '>=3.11');
            assert.strictEqual(normalizeCpythonVersionInfo('3.12.not-a-version'), '3.12.not-a-version');
        });
    });

    suite('parseReleaseSegments', () => {
        test('parses dotted numeric release segments', () => {
            assert.deepStrictEqual(parseReleaseSegments('3.12.4'), [3, 12, 4]);
        });

        test('parses CPython sys.version_info release strings', () => {
            assert.deepStrictEqual(parseReleaseSegments('3.14.3.final.0'), [3, 14, 3]);
            assert.deepStrictEqual(parseReleaseSegments('3.14.0.candidate.2'), [3, 14, 0]);
        });

        test('does not zero-pad release segments (keeps uv install targets intact)', () => {
            assert.deepStrictEqual(parseReleaseSegments('3.13'), [3, 13]);
        });

        test('ignores syntax outside the release segments', () => {
            assert.deepStrictEqual(parseReleaseSegments(' v2!3.12.4rc1.post2.dev3+local '), [3, 12, 4]);
        });

        test('returns undefined when no release segment is present', () => {
            assert.strictEqual(parseReleaseSegments('not-a-version'), undefined);
        });

        test('returns undefined for an invalid PEP 440 suffix', () => {
            assert.strictEqual(parseReleaseSegments('3.12.not-a-version'), undefined);
        });
    });

    suite('compareReleaseSegments', () => {
        test('pads missing trailing segments with zero', () => {
            assert.strictEqual(compareReleaseSegments([3, 12], [3, 12, 0]), 0);
        });

        test('compares each segment numerically', () => {
            assert.ok(compareReleaseSegments([3, 12, 10], [3, 12, 9]) > 0);
            assert.ok(compareReleaseSegments([3, 11, 9], [3, 12]) < 0);
        });
    });
});