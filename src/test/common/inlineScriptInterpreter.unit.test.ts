// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { extractLowerBoundVersion, pickCompatibleInterpreter } from '../../common/inlineScriptInterpreter';
import * as logging from '../../common/logging';

function makeEnv(version: string, name = `Python ${version}`, error?: string): PythonEnvironment {
    return {
        envId: { id: name, managerId: 'ms-python.python:system' },
        name,
        displayName: name,
        displayPath: `/usr/bin/${name}`,
        version,
        environmentPath: Uri.file(`/usr/bin/${name}`),
        execInfo: { run: { executable: `/usr/bin/${name}` } },
        sysPrefix: '/usr',
        error,
    };
}

suite('inlineScriptInterpreter', () => {
    let traceWarnStub: sinon.SinonStub;

    setup(() => {
        traceWarnStub = sinon.stub(logging, 'traceWarn');
    });

    teardown(() => {
        sinon.restore();
    });

    suite('pickCompatibleInterpreter', () => {
        test('returns undefined when the input list is empty', () => {
            assert.strictEqual(pickCompatibleInterpreter([], undefined), undefined);
            assert.strictEqual(pickCompatibleInterpreter([], '>=3.11'), undefined);
        });

        test('with no constraint, picks the newest non-errored Python 3', () => {
            const envs = [makeEnv('3.10.5'), makeEnv('3.12.4'), makeEnv('3.11.2')];
            const picked = pickCompatibleInterpreter(envs, undefined);
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.4');
        });

        test('with a >= constraint, picks the newest version that satisfies it', () => {
            const envs = [makeEnv('3.10.5'), makeEnv('3.12.4'), makeEnv('3.11.2'), makeEnv('3.13.0')];
            const picked = pickCompatibleInterpreter(envs, '>=3.11');
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.13.0');
        });

        test('with a multi-clause constraint, picks the newest version within the range', () => {
            const envs = [makeEnv('3.10.5'), makeEnv('3.12.4'), makeEnv('3.11.2'), makeEnv('3.13.0')];
            const picked = pickCompatibleInterpreter(envs, '>=3.11,<3.13');
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.4');
        });

        test('returns undefined when no installed env satisfies the constraint', () => {
            const envs = [makeEnv('3.10.5'), makeEnv('3.11.2')];
            assert.strictEqual(pickCompatibleInterpreter(envs, '>=3.13'), undefined);
        });

        test('skips envs with an error set even if their version would match', () => {
            const envs = [makeEnv('3.13.0', 'broken', 'pyvenv.cfg missing'), makeEnv('3.12.4')];
            const picked = pickCompatibleInterpreter(envs, '>=3.11');
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.4');
        });

        test('skips envs whose version is empty', () => {
            const envs = [makeEnv('', 'unknown'), makeEnv('3.12.4')];
            const picked = pickCompatibleInterpreter(envs, undefined);
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.4');
        });

        test('skips envs whose version does not parse as a leading integer', () => {
            const envs = [makeEnv('not-a-version', 'broken-version'), makeEnv('3.12.4')];
            const picked = pickCompatibleInterpreter(envs, undefined);
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.4');
        });

        test('skips Python 2 even when no constraint is given', () => {
            const envs = [makeEnv('2.7.18'), makeEnv('3.11.0')];
            const picked = pickCompatibleInterpreter(envs, undefined);
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.11.0');
        });

        test('returns undefined when only Python 2 is installed and no constraint is given', () => {
            const envs = [makeEnv('2.7.18')];
            assert.strictEqual(pickCompatibleInterpreter(envs, undefined), undefined);
        });

        test('tolerates a leading "v" prefix when ranking versions', () => {
            const envs = [makeEnv('v3.12.0', 'v3'), makeEnv('3.11.0')];
            const picked = pickCompatibleInterpreter(envs, undefined);
            assert.ok(picked);
            assert.strictEqual(picked.version, 'v3.12.0');
        });

        test('breaks version ties by input order (stable sort)', () => {
            const a = makeEnv('3.12.4', 'first-3.12.4');
            const b = makeEnv('3.12.4', 'second-3.12.4');
            const picked = pickCompatibleInterpreter([a, b], undefined);
            assert.strictEqual(picked, a);
            const pickedReversed = pickCompatibleInterpreter([b, a], undefined);
            assert.strictEqual(pickedReversed, b);
        });

        test('handles a mix of broken and version-unparseable entries cleanly', () => {
            const envs = [
                makeEnv('', 'no-version'),
                makeEnv('3.13.0', 'broken', 'install broken'),
                makeEnv('not-a-version', 'garbage'),
                makeEnv('3.11.7'),
            ];
            const picked = pickCompatibleInterpreter(envs, '>=3.10');
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.11.7');
        });

        test('does not mutate the input array', () => {
            const envs = [makeEnv('3.10.0'), makeEnv('3.12.0'), makeEnv('3.11.0')];
            const snapshot = envs.map((e) => e.version);
            pickCompatibleInterpreter(envs, undefined);
            assert.deepStrictEqual(
                envs.map((e) => e.version),
                snapshot,
            );
        });

        test('uses matchesPythonVersion semantics for wildcard specs (==3.12.*)', () => {
            const envs = [makeEnv('3.12.0'), makeEnv('3.12.7'), makeEnv('3.13.0')];
            const picked = pickCompatibleInterpreter(envs, '==3.12.*');
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.7');
        });

        test('honors the implicit upper bound of a ~=X.Y.Z clause', () => {
            // `~=3.12.4` ≡ `>=3.12.4, ==3.12.*`. 3.13.0 must NOT be picked.
            const envs = [makeEnv('3.12.4'), makeEnv('3.12.7'), makeEnv('3.13.0')];
            const picked = pickCompatibleInterpreter(envs, '~=3.12.4');
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.7');
        });

        test('returns undefined when only versions above the ~= cap are installed', () => {
            const envs = [makeEnv('3.13.0'), makeEnv('3.14.0')];
            assert.strictEqual(pickCompatibleInterpreter(envs, '~=3.12.4'), undefined);
        });

        test('empty-string requiresPython is treated as no constraint (not "matches nothing")', () => {
            const envs = [makeEnv('3.10.0'), makeEnv('3.12.4')];
            const picked = pickCompatibleInterpreter(envs, '');
            assert.ok(picked, 'empty constraint must not silently reject all envs');
            assert.strictEqual(picked.version, '3.12.4');
        });

        test('ranks versions with pre-release / dev / local suffixes by release segments only', () => {
            // 3.12.0a1 and 3.12.0.dev1 both parse to [3,12,0]; stable sort
            // means the first-listed 3.12 entry wins.
            const envs = [makeEnv('3.12.0a1'), makeEnv('3.11.0'), makeEnv('3.12.0.dev1')];
            const picked = pickCompatibleInterpreter(envs, undefined);
            assert.ok(picked);
            assert.strictEqual(picked.version, '3.12.0a1');
        });
    });

    suite('extractLowerBoundVersion', () => {
        test('returns undefined for undefined / empty / whitespace input', () => {
            assert.strictEqual(extractLowerBoundVersion(undefined), undefined);
            assert.strictEqual(extractLowerBoundVersion(''), undefined);
            assert.strictEqual(extractLowerBoundVersion('   '), undefined);
            assert.strictEqual(extractLowerBoundVersion(' , , '), undefined);
        });

        test('extracts the literal version from a >= clause', () => {
            assert.strictEqual(extractLowerBoundVersion('>=3.13'), '3.13');
            assert.strictEqual(extractLowerBoundVersion('>=3.12.4'), '3.12.4');
            assert.strictEqual(extractLowerBoundVersion('>=3'), '3');
        });

        test('extracts the literal version from a ~= clause', () => {
            assert.strictEqual(extractLowerBoundVersion('~=3.12'), '3.12');
            assert.strictEqual(extractLowerBoundVersion('~=3.12.4'), '3.12.4');
        });

        test('extracts the literal version from an == clause (without wildcard)', () => {
            assert.strictEqual(extractLowerBoundVersion('==3.12'), '3.12');
            assert.strictEqual(extractLowerBoundVersion('==3.12.7'), '3.12.7');
        });

        test('strips trailing .* from an == wildcard', () => {
            assert.strictEqual(extractLowerBoundVersion('==3.12.*'), '3.12');
            assert.strictEqual(extractLowerBoundVersion('==3.*'), '3');
        });

        test('picks the tightest lower bound across multiple lower-bound clauses', () => {
            assert.strictEqual(extractLowerBoundVersion('>=3.10,>=3.12'), '3.12');
            assert.strictEqual(extractLowerBoundVersion('>=3.12,>=3.10'), '3.12');
            assert.strictEqual(extractLowerBoundVersion('>=3.10.5,>=3.10.4'), '3.10.5');
        });

        test('treats a mixed-clause spec as the lower bound of the lower-bound clauses only', () => {
            assert.strictEqual(extractLowerBoundVersion('>=3.11,<3.13'), '3.11');
            assert.strictEqual(extractLowerBoundVersion('<3.13,>=3.11'), '3.11');
            assert.strictEqual(extractLowerBoundVersion('>=3.11,!=3.12.0,<3.13'), '3.11');
        });

        test('returns undefined when there is no lower-bound clause', () => {
            assert.strictEqual(extractLowerBoundVersion('<3.13'), undefined);
            assert.strictEqual(extractLowerBoundVersion('<=3.12'), undefined);
            assert.strictEqual(extractLowerBoundVersion('!=3.10'), undefined);
            assert.strictEqual(extractLowerBoundVersion('<3.13,<=3.12'), undefined);
        });

        test('returns undefined for the > operator (no clean integer floor)', () => {
            assert.strictEqual(extractLowerBoundVersion('>3.12'), undefined);
        });

        test('returns undefined for the === operator (opaque string shape)', () => {
            assert.strictEqual(extractLowerBoundVersion('===3.12.0'), undefined);
        });

        test('returns undefined for an unrecognized clause and logs a traceWarn', () => {
            assert.strictEqual(extractLowerBoundVersion('weird-thing'), undefined);
            assert.ok(traceWarnStub.called);
        });

        test('tolerates whitespace around clauses and operators', () => {
            assert.strictEqual(extractLowerBoundVersion(' >= 3.11 , < 3.13 '), '3.11');
            assert.strictEqual(extractLowerBoundVersion('>=  3.12.4'), '3.12.4');
        });

        test('strips a leading v on the literal', () => {
            assert.strictEqual(extractLowerBoundVersion('>=v3.12'), '3.12');
            assert.strictEqual(extractLowerBoundVersion('>=v3.12.4'), '3.12.4');
        });

        test('rejects ~= with fewer than two release segments and logs a traceWarn', () => {
            assert.strictEqual(extractLowerBoundVersion('~=3'), undefined);
            assert.ok(traceWarnStub.called, 'expected a traceWarn for the illegal ~=3 clause');
        });

        test('rejects wildcards on >= and ~= (only == / != accept .*)', () => {
            assert.strictEqual(extractLowerBoundVersion('>=3.12.*'), undefined);
            assert.strictEqual(extractLowerBoundVersion('>=3.*'), undefined);
            assert.strictEqual(extractLowerBoundVersion('~=3.12.*'), undefined);
            assert.ok(traceWarnStub.called);
        });
    });
});
