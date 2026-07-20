// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { compareReleaseSegments, parseReleaseSegments } from '../../../common/utils/pep440Release';

suite('pep440Release', () => {
    suite('parseReleaseSegments', () => {
        test('parses dotted numeric release segments', () => {
            assert.deepStrictEqual(parseReleaseSegments('3.12.4'), [3, 12, 4]);
        });

        test('ignores syntax outside the release segments', () => {
            assert.deepStrictEqual(parseReleaseSegments(' v2!3.12.4rc1.post2.dev3+local '), [3, 12, 4]);
        });

        test('returns undefined when no release segment is present', () => {
            assert.strictEqual(parseReleaseSegments('not-a-version'), undefined);
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