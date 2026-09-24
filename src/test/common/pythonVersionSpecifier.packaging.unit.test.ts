// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//
// Test data in this file is derived from the pypa/packaging project.
//   Source:    https://github.com/pypa/packaging/blob/main/tests/test_specifiers.py
//   Copyright: Donald Stufft and individual contributors
//   License:   BSD-2-Clause (packaging is dual-licensed Apache-2.0 / BSD-2-Clause)
//
// Expected values follow packaging's DEFAULT prerelease semantics. Upstream forces
// `prereleases=True`, which reports a different result for five wildcard and four
// `<=` cases below; do not "correct" them back to the upstream values.
//
// Cases using epochs, local version labels, post/dev releases, or more than three
// release segments are omitted: a Python interpreter version never has them, and
// PythonVersion deliberately does not model them.

import assert from 'node:assert';
import { PythonVersion } from '../../common/pythonVersion';
import { PythonVersionSpecifier } from '../../common/pythonVersionSpecifier';

/** Mirrors `matchesPythonVersion`: malformed input yields `undefined`, never a throw. */
function matches(version: string, specifier: string): boolean | undefined {
    const parsedVersion = PythonVersion.tryParse(version);
    const parsedSpecifier = PythonVersionSpecifier.tryParse(specifier);
    return parsedVersion && parsedSpecifier ? parsedSpecifier.matches(parsedVersion) : undefined;
}

const INVALID_SPECIFIERS: readonly string[] = [
    '2.0',
    '=>2.0',
    '==',
    '~=1.0+5',
    '>=1.0+deadbeef',
    '<=1.0+abc123',
    '>1.0+watwat',
    '<1.0+1.0',
    '~=1.0.*',
    '>=1.0.*',
    '<=1.0.*',
    '>1.0.*',
    '<1.0.*',
    '==1.0.*+5',
    '!=1.0.*+deadbeef',
    '==2.0a1.*',
    '!=2.0a1.*',
    '==2.0.post1.*',
    '!=2.0.post1.*',
    '==2.0.dev1.*',
    '!=2.0.dev1.*',
    '==1.0+5.*',
    '!=1.0+deadbeef.*',
    '==1.0.*.5',
    '~=1',
    '==1.0.dev1.*',
    '!=1.0.dev1.*',
    '==1.2+\u0130',
    '==1.2+\u0130\u0131\u017fK',
    '~=1.2.3prev\u0131ew1',
    '~=1.2.3po\u017ft1',
];

const MATCH_CASES: ReadonlyArray<readonly [specifier: string, version: string, expected: boolean]> = [
    ['==2', '2.0', true],
    ['==2.0', '2.0', true],
    ['==2.0.0', '2.0', true],
    ['==2.*', '2a1', false],
    ['==2.*', '2b1', false],
    ['==2.*', '2c1', false],
    ['==2.*', '2rc1', false],
    ['==2.0.*', '2rc1', false],
    ['==2.*', '2', true],
    ['==2.0.*', '2', true],
    ['==2.0.0.*', '2', true],
    ['==2.*', '2.0', true],
    ['==2.*', '2.0.0', true],
    ['!=2', '2.1', true],
    ['!=2.0', '2.1', true],
    ['!=2', '2.0.1', true],
    ['!=2.0', '2.0.1', true],
    ['!=2.0.0', '2.0.1', true],
    ['!=3.*', '2.0', true],
    ['!=2.0.*', '2.1', true],
    ['!=2.0.0.*', '3', true],
    ['>=2', '2.0', true],
    ['>=2.0', '2.0', true],
    ['>=2.0.0', '2.0', true],
    ['>=2', '3', true],
    ['>=3.0.0a7', '3.0.0a8', true],
    ['<=2', '2.0', true],
    ['<=2.0', '2.0', true],
    ['<=2.0.0', '2.0', true],
    ['<=2', '2.0a1', false],
    ['<=2', '2.0b1', false],
    ['<=2', '2.0c1', false],
    ['<=2', '2.0rc1', false],
    ['<=2', '1', true],
    ['<=3.0.0a8', '3.0.0a7', true],
    ['>2', '3', true],
    ['>2.0', '2.1', true],
    ['>2', '2.0.1', true],
    ['<2', '1', true],
    ['<2.1', '2.0', true],
    ['~=1.0', '1', true],
    ['~=1.0', '1.0.1', true],
    ['~=1.0', '1.1', true],
    ['~=1.0', '1.9999999', true],
    ['~=1.0a1', '1.1', true],
    ['~=2022.01.01', '2022.01.01', true],
    ['==2', '2.1', false],
    ['==2.0', '2.1', false],
    ['==2.0.0', '2.1', false],
    ['==3.*', '2.0', false],
    ['==2.0.*', '2.1', false],
    ['==2.0.0.*', '3', false],
    ['!=2', '2.0', false],
    ['!=2.0', '2.0', false],
    ['!=2.0.0', '2.0', false],
    ['!=2.*', '2a1', false],
    ['!=2.*', '2b1', false],
    ['!=2.*', '2c1', false],
    ['!=2.*', '2rc1', false],
    ['!=2.0.*', '2rc1', false],
    ['!=2.*', '2', false],
    ['!=2.0.*', '2', false],
    ['!=2.0.0.*', '2', false],
    ['!=2.*', '2.0', false],
    ['!=2.*', '2.0.0', false],
    ['>=2', '2.0a1', false],
    ['>=2', '2.0b1', false],
    ['>=2', '2.0c1', false],
    ['>=2', '2.0rc1', false],
    ['>=2', '1', false],
    ['<=2', '3', false],
    ['>2', '1', false],
    ['>2', '2.0a1', false],
    ['>2', '2.0b1', false],
    ['>2', '2.0c1', false],
    ['>2', '2.0rc1', false],
    ['>2', '2.0', false],
    ['<2', '2.0a1', false],
    ['<2', '2.0b1', false],
    ['<2', '2.0c1', false],
    ['<2', '2.0rc1', false],
    ['<2', '2.0', false],
    ['<2', '3', false],
    ['~=1.0', '2.0', false],
    ['~=1.0.0', '1.1.0', false],
];

// packaging enables prereleases only for ==, >=, <=, ~= and ===; we enable them for any
// clause naming one, so these two cases intentionally differ from packaging's default.
const INTENTIONAL_DIVERGENCES: ReadonlyArray<readonly [specifier: string, version: string, expected: boolean]> = [
    ['>3.0.0a7', '3.0.0a8', true],
    ['<3.0.0a8', '3.0.0a7', true],
];

suite('PythonVersionSpecifier packaging conformance', () => {
    suite('rejects specifiers packaging rejects', () => {
        for (const specifier of INVALID_SPECIFIERS) {
            test(`rejects ${JSON.stringify(specifier)}`, () => {
                assert.strictEqual(PythonVersionSpecifier.tryParse(specifier), undefined);
            });
        }
    });

    suite('matches packaging semantics', () => {
        for (const [specifier, version, expected] of MATCH_CASES) {
            test(`${specifier} ${expected ? 'matches' : 'does not match'} ${version}`, () => {
                assert.strictEqual(matches(version, specifier), expected);
            });
        }
    });

    suite('diverges from packaging by design', () => {
        for (const [specifier, version, expected] of INTENTIONAL_DIVERGENCES) {
            test(`${specifier} ${expected ? 'matches' : 'does not match'} ${version}`, () => {
                assert.strictEqual(matches(version, specifier), expected);
            });
        }
    });
});
