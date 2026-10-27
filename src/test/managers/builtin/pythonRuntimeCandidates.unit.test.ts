// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { PythonVersion } from '../../../common/pythonVersion';
import { InstallerProcessError } from '../../../common/installerProcess';
import * as pymanager from '../../../managers/builtin/pymanagerPythonInstaller';
import { PymanagerRuntime } from '../../../managers/builtin/pymanagerPythonInstaller';
import { PythonInstallationError, PythonInstallRequest } from '../../../managers/builtin/pythonInstallerTypes';
import {
    getPreferredPythonSelector,
    getPymanagerCandidates,
    getPymanagerRuntimeVersion,
    getPythonRuntimeArchitecture,
    matchesPythonInstallRequest,
    PythonRuntimeArchitecture,
    resolvePymanagerCandidate,
    toPymanagerCandidate,
    validatePythonInstallRequest,
} from '../../../managers/builtin/pythonRuntimeCandidates';

const SUFFIXES: Readonly<Record<PythonRuntimeArchitecture, string>> = { x64: '64', arm64: 'arm64', ia32: '32' };

function tag(version: string, architecture: PythonRuntimeArchitecture = 'x64'): string {
    return `PythonCore\\${version}-${SUFFIXES[architecture]}`;
}

function runtime(
    version: string,
    overrides: Partial<PymanagerRuntime> = {},
    architecture: PythonRuntimeArchitecture = 'x64',
): PymanagerRuntime {
    const family = version.split('.').slice(0, 2).join('.');
    const development = /(?:a|b|rc)\d+$/i.test(version) ? '-dev' : '';
    const suffix = SUFFIXES[architecture];
    return {
        id: `pythoncore-${family}${development}-${suffix}`,
        company: 'PythonCore',
        version,
        tag: `${family}${development}-${suffix}`,
        installTags: [`${family}${development}-${suffix}`, `${version}-${suffix}`],
        executable: 'python.exe',
        executableArgs: [],
        unmanaged: false,
        ...overrides,
    };
}

interface CatalogueStep {
    readonly selectors: readonly string[];
    readonly runtimes: readonly PymanagerRuntime[];
}

suite('pythonRuntimeCandidates', () => {
    const executable = path.join(process.cwd(), 'resolver fixtures', 'pymanager.exe');
    let hostArchitecture: sinon.SinonStub;
    let list: sinon.SinonStub<
        Parameters<typeof pymanager.listPymanagerRuntimes>,
        ReturnType<typeof pymanager.listPymanagerRuntimes>
    >;

    setup(() => {
        hostArchitecture = sinon.stub(process, 'arch').value('x64');
        list = sinon.stub(pymanager, 'listPymanagerRuntimes').rejects(new Error('Unexpected catalogue query'));
    });

    teardown(() => sinon.restore());

    function catalogue(steps: readonly CatalogueStep[]): () => void {
        let next = 0;
        list.callsFake(async (command, options) => {
            const step = steps[next++];
            assert.ok(step, `Unexpected catalogue query ${next}: ${JSON.stringify(options?.selectors)}`);
            assert.strictEqual(command, executable);
            assert.strictEqual(options?.online, true);
            assert.deepStrictEqual(options?.selectors, step.selectors, `Catalogue query ${next}`);
            assert.strictEqual(options?.onlyManaged, undefined);
            return [...step.runtimes];
        });
        return () => assert.strictEqual(list.callCount, steps.length, 'Expected all catalogue steps to be used');
    }

    function isBudgetError(error: unknown): boolean {
        assert.ok(error instanceof PythonInstallationError);
        assert.strictEqual(error.reason, 'catalogue-failed');
        return true;
    }

    suite('request semantics', () => {
        const cases: readonly {
            readonly actual: string;
            readonly request: PythonInstallRequest;
            readonly matches: boolean;
        }[] = [
            { actual: '3.14.7', request: {}, matches: true },
            { actual: '3.15.0a7', request: {}, matches: false },
            { actual: '2.7.18', request: {}, matches: false },
            { actual: '4.0.0', request: {}, matches: false },
            { actual: '3.14.7', request: { version: '3' }, matches: true },
            { actual: '3.13.12', request: { version: '3.13' }, matches: true },
            { actual: '3.14.0', request: { version: '3.13' }, matches: false },
            { actual: '3.13.0', request: { version: '3.13.0' }, matches: true },
            { actual: '3.13.1', request: { version: '3.13.0' }, matches: false },
            { actual: '3.13.0', request: { requiresPython: '==3.13' }, matches: true },
            { actual: '3.13.1', request: { requiresPython: '==3.13' }, matches: false },
            { actual: '3.13.12', request: { requiresPython: '==3.13.*' }, matches: true },
            { actual: '3.14.0', request: { requiresPython: '==3.13.*' }, matches: false },
            { actual: '3.13.12', request: { requiresPython: '>=3.13,<3.14' }, matches: true },
            { actual: '3.14.0', request: { requiresPython: '>=3.13,<3.14' }, matches: false },
            { actual: '3.14.6', request: { requiresPython: '!=3.14.7' }, matches: true },
            { actual: '3.14.7', request: { requiresPython: '!=3.14.7' }, matches: false },
            { actual: '3.13.12', request: { requiresPython: '~=3.13.2' }, matches: true },
            { actual: '3.14.0', request: { requiresPython: '~=3.13.2' }, matches: false },
            { actual: '3.15.0rc3', request: { version: '3.15.0candidate3' }, matches: true },
            { actual: '3.15.0rc4', request: { version: '3.15.0rc3' }, matches: false },
            { actual: '3.15.0rc3', request: { version: '3.15' }, matches: false },
            { actual: '3.15.0rc3', request: { requiresPython: '>=3.15' }, matches: false },
            { actual: '3.15.0rc3', request: { requiresPython: '>=3.15.0rc1' }, matches: true },
            { actual: '3.14.0rc2', request: { requiresPython: '<3.14.0rc3' }, matches: true },
            { actual: '3.14.0b4', request: { requiresPython: '<3.14.0rc3' }, matches: true },
            { actual: '3.14.0rc3', request: { requiresPython: '<3.14.0rc3' }, matches: false },
            { actual: '3.14.0rc1', request: { requiresPython: '>=3.13.0rc1,<3.14' }, matches: false },
            { actual: '3.13.5rc1', request: { requiresPython: '>=3.13.0rc1,<3.14' }, matches: true },
            { actual: '3.13.12', request: { version: '3.13', requiresPython: '<3.13.10' }, matches: false },
            { actual: '3.13.9', request: { version: '3.13', requiresPython: '<3.13.10' }, matches: true },
            { actual: '3.14.7', request: { version: '3.13', requiresPython: '>=3.14' }, matches: false },
            { actual: '3.13.0', request: { version: ' 3.13 ', requiresPython: ' == 3.13 ' }, matches: true },
            { actual: '3.14.7', request: { version: 'bad' }, matches: false },
            { actual: '3.14.7', request: { requiresPython: 'bad' }, matches: false },
        ];

        for (const entry of cases) {
            test(`${entry.actual} matches ${JSON.stringify(entry.request)}: ${entry.matches}`, () => {
                assert.strictEqual(
                    matchesPythonInstallRequest(new PythonVersion(entry.actual), entry.request),
                    entry.matches,
                );
                sinon.assert.notCalled(list);
            });
        }

        const invalid: readonly PythonInstallRequest[] = [
            { version: '' },
            { version: ' ' },
            { version: '3.x' },
            { version: '>=3.13' },
            { version: '3.13.*' },
            { version: '3.14.0.post1' },
            { version: '3.14.0+local' },
            { version: '3.14\n--force' },
            { requiresPython: '' },
            { requiresPython: '3.13' },
            { requiresPython: '>=3.13.*' },
            { requiresPython: '~=3' },
            { requiresPython: '>=3.13,' },
            { requiresPython: '>=3.13,invalid' },
            { requiresPython: '>=3.13 || <3.12' },
        ];

        for (const request of invalid) {
            test(`rejects invalid request before catalogue access: ${JSON.stringify(request)}`, async () => {
                const check = (error: unknown): boolean => {
                    assert.ok(error instanceof PythonInstallationError);
                    assert.strictEqual(error.reason, 'no-compatible-python');
                    return true;
                };
                assert.throws(() => validatePythonInstallRequest(request), check);
                await assert.rejects(resolvePymanagerCandidate(executable, request), check);
                sinon.assert.notCalled(list);
            });
        }

        test('accepts an unspecified request and valid but contradictory clauses for later resolution', () => {
            assert.doesNotThrow(() => validatePythonInstallRequest({}));
            assert.doesNotThrow(() => validatePythonInstallRequest({ requiresPython: '>=3.14,<3.13' }));
        });
    });

    suite('preferred selectors', () => {
        const cases: readonly [string | undefined, string | undefined][] = [
            [undefined, undefined],
            ['', undefined],
            [' ', undefined],
            ['>=3', '3'],
            ['>=3.13', '3.13'],
            ['>= 3.13 ', '3.13'],
            ['>=v3.13', '3.13'],
            ['>=3.13.2', '3.13.2'],
            ['==3.13', '3.13.0'],
            ['==3.13.2', '3.13.2'],
            ['==3.13.*', undefined],
            ['~=3.13.2', undefined],
            ['>3.13', undefined],
            ['<3.14', undefined],
            ['<=3.14', undefined],
            ['!=3.14.7', undefined],
            ['>=3.13,<3.14', undefined],
            ['>=3.13,!=3.13.0', undefined],
            ['>=3.15.0rc1,<3.16', '3.15.0rc1'],
            ['==3.15.0beta2', '3.15.0b2'],
            ['>=3.15.0b2,!=3.15.0b2', undefined],
            ['>=2.7', undefined],
            ['>=3.13.*', undefined],
            ['invalid', undefined],
            [' >=3.13 ', '3.13'],
            [' == 3.13 ', '3.13.0'],
        ];

        for (const [constraint, expected] of cases) {
            test(`${JSON.stringify(constraint)} prefers ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(getPreferredPythonSelector(constraint), expected);
                sinon.assert.notCalled(list);
            });
        }
    });

    suite('architecture and runtime metadata', () => {
        for (const architecture of ['x64', 'arm64', 'ia32'] as const) {
            test(`uses extension-host ${architecture} and its native installation suffix`, () => {
                hostArchitecture.value(architecture);
                assert.strictEqual(getPythonRuntimeArchitecture(), architecture);
                const entry = runtime('3.14.7', {}, architecture);
                const candidate = toPymanagerCandidate(entry);
                assert.ok(candidate);
                assert.strictEqual(candidate.architecture, architecture);
                assert.strictEqual(candidate.installTag, tag('3.14.7', architecture));
                assert.strictEqual(candidate.runtime, entry);
                assert.strictEqual(candidate.version.toString(), '3.14.7');
            });
        }

        test('classifies unsupported host architecture instead of guessing from the desktop or executable', () => {
            hostArchitecture.value('s390x');
            assert.throws(getPythonRuntimeArchitecture, (error: unknown) => {
                assert.ok(error instanceof PythonInstallationError);
                assert.strictEqual(error.reason, 'provider-unusable');
                return true;
            });
        });

        test('derives the actual release from version rather than the slot ID or short tag', () => {
            const entry = runtime('3.14.7', { id: 'pythoncore-3.14-64', tag: '3.14-64' });
            assert.strictEqual(getPymanagerRuntimeVersion(entry)?.toString(), '3.14.7');
            assert.strictEqual(toPymanagerCandidate(entry)?.installTag, tag('3.14.7'));
        });

        test('accepts standard development slots and preserves advertised tag casing', () => {
            const entry = runtime(
                '3.15.0rc3',
                { company: 'PYTHONCORE', tag: '3.15-dev-ARM64', installTags: ['3.15.0RC3-ARM64'] },
                'arm64',
            );
            assert.strictEqual(toPymanagerCandidate(entry, 'arm64')?.installTag, 'PythonCore\\3.15.0RC3-ARM64');
        });

        const rejected: readonly [string, Partial<PymanagerRuntime>][] = [
            ['another company', { company: 'Other' }],
            ['lookalike company', { company: 'PythonCore.Other' }],
            ['Python 2', { version: '2.7.18' }],
            ['Python 4', { version: '4.0.0' }],
            ['invalid actual version', { version: 'not a release' }],
            ['package dev version', { version: '3.14.7.dev1' }],
            ['free-threaded family', { tag: '3.14t-64' }],
            ['free-threaded concrete tag', { tag: '3.14.7t-64' }],
            ['embeddable build', { tag: '3.14-embed-64' }],
            ['debug build', { tag: '3.14-debug-64' }],
            ['wrong architecture arm64', { tag: '3.14-arm64' }],
            ['wrong architecture ia32', { tag: '3.14-32' }],
            ['lookalike architecture suffix', { tag: '3.14-64-extra' }],
            ['missing architecture', { tag: '3.14' }],
            ['unqualified family', { tag: '3-64' }],
            ['required executable args', { executableArgs: ['-X', 'gil=0'] }],
        ];

        for (const [name, overrides] of rejected) {
            test(`rejects ${name}`, () => {
                const entry = runtime('3.14.7', overrides);
                assert.strictEqual(getPymanagerRuntimeVersion(entry, 'x64'), undefined);
                assert.strictEqual(toPymanagerCandidate(entry, 'x64'), undefined);
            });
        }

        for (const installTags of [
            [],
            ['3.14', '3.14-64'],
            ['3.14.6-64'],
            ['3.14.7-arm64'],
            ['3.14.7-64-extra'],
            ['PythonCore\\3.14.7-64'],
        ]) {
            test(`does not invent a concrete tag from ${JSON.stringify(installTags)}`, () => {
                const entry = runtime('3.14.7', { tag: '3.14.7-64', installTags });
                assert.ok(getPymanagerRuntimeVersion(entry));
                assert.strictEqual(toPymanagerCandidate(entry), undefined);
            });
        }

        test('sorts eligible actual releases without mutating the catalogue or its records', () => {
            const entries = Object.freeze([
                Object.freeze(runtime('3.13.12')),
                Object.freeze(runtime('3.15.0a7')),
                Object.freeze(runtime('3.14.7')),
                Object.freeze(runtime('3.16.0', { company: 'Other' })),
            ]);
            assert.deepStrictEqual(
                getPymanagerCandidates(entries).map((candidate) => candidate.version.toString()),
                ['3.15.0a7', '3.14.7', '3.13.12'],
            );
            assert.deepStrictEqual(entries.map((entry) => entry.version), ['3.13.12', '3.15.0a7', '3.14.7', '3.16.0']);
        });
    });

    suite('catalogue resolution', () => {
        test('chooses the newest stable standard build by default, not the catalogue input order', async () => {
            const verify = catalogue([
                {
                    selectors: [],
                    runtimes: [
                        runtime('3.13.12'),
                        runtime('3.15.0a7'),
                        runtime('3.14.7'),
                        runtime('3.16.0', { company: 'Other' }),
                    ],
                },
            ]);
            const result = await resolvePymanagerCandidate(executable, {});
            assert.strictEqual(result?.installTag, tag('3.14.7'));
            verify();
        });

        test('returns undefined for an empty catalogue or one containing only future prereleases', async () => {
            list.resolves([]);
            assert.strictEqual(await resolvePymanagerCandidate(executable, {}), undefined);
            list.resolves([runtime('3.15.0a7')]);
            assert.strictEqual(await resolvePymanagerCandidate(executable, {}), undefined);
            assert.strictEqual(list.callCount, 2);
        });

        const selectors: readonly [PythonInstallRequest, string, string][] = [
            [{ version: '3.13' }, '3.13', '3.13.12'],
            [{ version: '3' }, '3', '3.14.7'],
            [{ version: '3.13.2' }, '3.13.2', '3.13.2'],
            [{ requiresPython: '==3.13' }, '3.13.0', '3.13.0'],
            [{ requiresPython: '==3.13.2' }, '3.13.2', '3.13.2'],
            [{ requiresPython: '>=3.13' }, '3.13', '3.13.12'],
            [{ version: '3.15.0candidate3' }, '3.15.0rc3', '3.15.0rc3'],
            [{ requiresPython: '>=3.15.0rc1,<3.16' }, '3.15.0rc1', '3.15.0rc1'],
        ];

        for (const [request, querySelector, actual] of selectors) {
            test(`queries ${querySelector} for ${JSON.stringify(request)}`, async () => {
                const verify = catalogue([{ selectors: [tag(querySelector)], runtimes: [runtime(actual)] }]);
                const result = await resolvePymanagerCandidate(executable, request);
                assert.strictEqual(result?.installTag, tag(actual));
                verify();
            });
        }

        test('keeps simple lower-bound family preference despite harmless surrounding whitespace', async () => {
            list.callsFake(async (_command, options) =>
                options?.selectors?.length
                    ? [runtime('3.13.12')]
                    : [runtime('3.14.7'), runtime('3.13.12')],
            );
            const result = await resolvePymanagerCandidate(executable, { requiresPython: ' >=3.13 ' });
            assert.strictEqual(result?.version.toString(), '3.13.12');
            assert.deepStrictEqual(list.firstCall.args[1]?.selectors, [tag('3.13')]);
        });

        test('does not pin compound constraints to their lower bound', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.13.12'), runtime('3.14.7'), runtime('3.15.0')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '>=3.13,<3.15' });
            assert.strictEqual(result?.version.toString(), '3.14.7');
            verify();
        });

        test('honors an explicit family selector together with its constraint', async () => {
            const verify = catalogue([{ selectors: [tag('3.13')], runtimes: [runtime('3.13.12')] }]);
            const result = await resolvePymanagerCandidate(executable, {
                version: '3.13',
                requiresPython: '>=3.12,<3.14',
            });
            assert.strictEqual(result?.version.toString(), '3.13.12');
            verify();
        });

        test('treats a derived family preference as a preference, not an additional constraint', async () => {
            const verify = catalogue([
                { selectors: [tag('3.13')], runtimes: [] },
                { selectors: [], runtimes: [runtime('3.14.7')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '>=3.13' });
            assert.strictEqual(result?.version.toString(), '3.14.7');
            verify();
        });

        test('does not fall back to a different family when the selector was explicit', async () => {
            const verify = catalogue([{ selectors: [tag('3.13')], runtimes: [] }]);
            assert.strictEqual(
                await resolvePymanagerCandidate(executable, { version: '3.13', requiresPython: '>=3.13' }),
                undefined,
            );
            verify();
        });

        test('falls back from an unpublished >=3.14.6 preference to compatible 3.14.7', async () => {
            const verify = catalogue([
                { selectors: [tag('3.14.6')], runtimes: [] },
                { selectors: [], runtimes: [runtime('3.14.7')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '>=3.14.6' });
            assert.strictEqual(result?.version.toString(), '3.14.7');
            verify();
        });

        test('does not broaden exact short equality when its preferred patch is missing', async () => {
            const verify = catalogue([
                { selectors: [tag('3.13.0')], runtimes: [] },
                { selectors: [], runtimes: [runtime('3.13.12')] },
                { selectors: [tag('3.13.0')], runtimes: [] },
            ]);
            assert.strictEqual(
                await resolvePymanagerCandidate(executable, { requiresPython: '==3.13' }),
                undefined,
            );
            verify();
        });

        test('does not install a different patch when an exact selector returns a false positive', async () => {
            const verify = catalogue([{ selectors: [tag('3.14.6')], runtimes: [runtime('3.14.7')] }]);
            assert.strictEqual(await resolvePymanagerCandidate(executable, { version: '3.14.6' }), undefined);
            verify();
        });

        test('does not substitute a final or a different serial for an exact prerelease', async () => {
            const verify = catalogue([{ selectors: [tag('3.14.0rc2')], runtimes: [runtime('3.14.0rc3')] }]);
            assert.strictEqual(await resolvePymanagerCandidate(executable, { version: '3.14.0rc2' }), undefined);
            verify();
        });

        test('rejects syntactically valid but contradictory requirements without inventing queries', async () => {
            const verify = catalogue([{ selectors: [], runtimes: [runtime('3.14.7'), runtime('3.13.12')] }]);
            assert.strictEqual(
                await resolvePymanagerCandidate(executable, { requiresPython: '>=3.14,<3.13' }),
                undefined,
            );
            verify();
        });

        const histories: readonly [string, string, readonly number[]][] = [
            ['>=3.14,<3.14.7', '3.14.6', [6, 5, 4, 3, 2, 1, 0]],
            ['<=3.14.6', '3.14.6', [6, 5, 4, 3, 2, 1, 0]],
            ['!=3.14.7', '3.14.6', [6, 5, 4, 3, 2, 1, 0]],
            ['>=3.14,<3.15,!=3.14.7,!=3.14.6', '3.14.5', [5, 4, 3, 2, 1, 0]],
            ['>=3.14.2,<3.14.6,!=3.14.4', '3.14.5', [5, 3, 2]],
        ];

        for (const [requiresPython, expected, patches] of histories) {
            test(`finds a hidden final patch for ${requiresPython} through exact compatible tags`, async () => {
                const verify = catalogue([
                    { selectors: [], runtimes: [runtime('3.14.7')] },
                    { selectors: patches.map((patch) => tag(`3.14.${patch}`)), runtimes: [runtime(expected)] },
                ]);
                const result = await resolvePymanagerCandidate(executable, { requiresPython });
                assert.strictEqual(result?.installTag, tag(expected));
                verify();
            });
        }

        test('rejects native tag/range false positives using the actual version', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7', { tag: '3.14-64' })] },
                {
                    selectors: [6, 5, 4, 3, 2, 1, 0].map((patch) => tag(`3.14.${patch}`)),
                    runtimes: [runtime('3.14.7', { tag: '3.14-64' })],
                },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.7' });
            assert.strictEqual(result, undefined);
            verify();
        });

        test('does not synthesize an installable runtime when exact history queries have no matches', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.6'), tag('3.14.5')], runtimes: [] },
            ]);
            assert.strictEqual(
                await resolvePymanagerCandidate(executable, { requiresPython: '>=3.14.5,<3.14.7' }),
                undefined,
            );
            verify();
        });

        test('batches descending exact final tags into at most 64 selectors and searches later batches', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.130')] },
                { selectors: Array.from({ length: 64 }, (_value, i) => tag(`3.14.${129 - i}`)), runtimes: [] },
                { selectors: Array.from({ length: 64 }, (_value, i) => tag(`3.14.${65 - i}`)), runtimes: [] },
                { selectors: [tag('3.14.1'), tag('3.14.0')], runtimes: [runtime('3.14.1')] },
            ]);
            assert.strictEqual(
                (await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.130' }))?.version.toString(),
                '3.14.1',
            );
            verify();
        });

        test('tries lower families only after exhausting eligible history of the newest family', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.13.12'), runtime('3.14.7')] },
                { selectors: [tag('3.14.1'), tag('3.14.0')], runtimes: [] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.2' });
            assert.strictEqual(result?.version.toString(), '3.13.12');
            verify();
        });

        test('requires an advertised concrete tag and no required executable arguments even for exact queries', async () => {
            const verify = catalogue([
                {
                    selectors: [tag('3.14.6')],
                    runtimes: [
                        runtime('3.14.6', { id: 'missing-concrete-tag', installTags: ['3.14-64'] }),
                        runtime('3.14.6', { id: 'requires-arguments', executableArgs: ['-X', 'special'] }),
                    ],
                },
            ]);
            assert.strictEqual(await resolvePymanagerCandidate(executable, { version: '3.14.6' }), undefined);
            verify();
        });

        for (const architecture of ['x64', 'arm64', 'ia32'] as const) {
            test(`threads explicit ${architecture} through native queries and returned candidate validation`, async () => {
                const wrongArchitecture = architecture === 'x64' ? 'arm64' : 'x64';
                const verify = catalogue([
                    {
                        selectors: [tag('3.14.6', architecture)],
                        runtimes: [runtime('3.14.6', {}, wrongArchitecture), runtime('3.14.6', {}, architecture)],
                    },
                ]);
                const result = await resolvePymanagerCandidate(executable, { version: '3.14.6' }, architecture);
                assert.strictEqual(result?.architecture, architecture);
                assert.strictEqual(result?.installTag, tag('3.14.6', architecture));
                verify();
            });
        }

        test('propagates native catalogue failures rather than returning no compatible version', async () => {
            const error = new InstallerProcessError('exit', 7);
            list.rejects(error);
            await assert.rejects(resolvePymanagerCandidate(executable, {}), (caught: unknown) => caught === error);
            sinon.assert.calledOnce(list);
        });
    });

    suite('prerelease catalogue history', () => {
        for (const [phase, serial] of [['rc', 3], ['b', 4], ['a', 7]] as const) {
            test(`queries the native ${phase} prefix and returns the advertised serial`, async () => {
                const phases = ['rc', 'b', 'a'];
                const target = `3.14.0${phase}${serial}`;
                const steps: CatalogueStep[] = [{ selectors: [], runtimes: [runtime('3.14.7')] }];
                for (const current of phases.slice(0, phases.indexOf(phase) + 1)) {
                    steps.push({
                        selectors: [tag(`3.14.0${current}`)],
                        runtimes: current === phase ? [runtime(target)] : [],
                    });
                }
                const verify = catalogue(steps);
                const result = await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.0rc4' });
                assert.strictEqual(result?.version.toString(), target);
                verify();
            });
        }

        test('backtracks rc serials and excludes native prefix results outside the request', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0rc')], runtimes: [runtime('3.14.0rc3')] },
                { selectors: [tag('3.14.0rc2'), tag('3.14.0rc0')], runtimes: [runtime('3.14.0rc2')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, {
                requiresPython: '<3.14.0rc3,!=3.14.0rc1',
            });
            assert.strictEqual(result?.version.toString(), '3.14.0rc2');
            verify();
        });

        test('searches compatible prereleases when a derived lower-bound serial is unpublished', async () => {
            const verify = catalogue([
                { selectors: [tag('3.14.0rc1')], runtimes: [] },
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0rc')], runtimes: [runtime('3.14.0rc3')] },
                { selectors: [tag('3.14.0rc2'), tag('3.14.0rc1')], runtimes: [runtime('3.14.0rc2')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, {
                requiresPython: '>=3.14.0rc1,<3.14.0rc3',
            });
            assert.strictEqual(result?.version.toString(), '3.14.0rc2');
            verify();
        });

        test('skips the rc phase and backtracks beta serials for a beta-only upper bound', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0b')], runtimes: [runtime('3.14.0b4')] },
                {
                    selectors: [tag('3.14.0b3'), tag('3.14.0b2'), tag('3.14.0b1'), tag('3.14.0b0')],
                    runtimes: [runtime('3.14.0b3')],
                },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '>3.14.0a0,<3.14.0b4' });
            assert.strictEqual(result?.version.toString(), '3.14.0b3');
            verify();
        });

        test('backtracks alpha serials without probing higher incompatible phases', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0a')], runtimes: [runtime('3.14.0a7')] },
                { selectors: [tag('3.14.0a6'), tag('3.14.0a5'), tag('3.14.0a4')], runtimes: [runtime('3.14.0a5')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '>3.14.0a3,<3.14.0a7' });
            assert.strictEqual(result?.version.toString(), '3.14.0a5');
            verify();
        });

        test('queries beta after an rc prefix has no compatible historical matches', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0rc')], runtimes: [runtime('3.14.0rc3')] },
                { selectors: [tag('3.14.0rc2'), tag('3.14.0rc1'), tag('3.14.0rc0')], runtimes: [] },
                { selectors: [tag('3.14.0b')], runtimes: [runtime('3.14.0b4')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.0rc3' });
            assert.strictEqual(result?.version.toString(), '3.14.0b4');
            verify();
        });

        test('ignores a prefix response from the wrong numeric release or phase', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                {
                    selectors: [tag('3.14.0rc')],
                    runtimes: [
                        runtime('3.13.0rc3'),
                        runtime('3.14.0a7', { id: 'wrong-phase' }),
                        runtime('3.14.1rc2', { id: 'wrong-patch' }),
                    ],
                },
                { selectors: [tag('3.14.0b')], runtimes: [runtime('3.14.0b4')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.0rc4' });
            assert.strictEqual(result?.version.toString(), '3.14.0b4');
            verify();
        });

        test('prefers a newer-patch prerelease to an older final when both satisfy the constraint', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.2')] },
                { selectors: [tag('3.14.0')], runtimes: [runtime('3.14.0')] },
                { selectors: [tag('3.14.1rc')], runtimes: [runtime('3.14.1rc3')] },
                {
                    selectors: [tag('3.14.1rc2'), tag('3.14.1rc1'), tag('3.14.1rc0')],
                    runtimes: [runtime('3.14.1rc2')],
                },
            ]);
            const result = await resolvePymanagerCandidate(executable, { requiresPython: '<3.14.1rc3' });
            assert.strictEqual(result?.version.toString(), '3.14.1rc2');
            verify();
        });

        test('does not probe prereleases of an exclusive final upper bound even when prereleases are enabled', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7'), runtime('3.13.12')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, {
                requiresPython: '>3.13.0rc1,<3.14',
            });
            assert.strictEqual(result?.version.toString(), '3.13.12');
            verify();
        });

        test('batches compatible prerelease serials, excluding out-of-range or explicitly excluded serials', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0rc')], runtimes: [runtime('3.14.0rc130')] },
                {
                    selectors: Array.from({ length: 64 }, (_value, i) => tag(`3.14.0rc${129 - i}`)),
                    runtimes: [],
                },
                {
                    selectors: Array.from({ length: 64 }, (_value, i) => tag(`3.14.0rc${65 - i}`)),
                    runtimes: [],
                },
                { selectors: [tag('3.14.0rc1')], runtimes: [runtime('3.14.0rc1')] },
            ]);
            const result = await resolvePymanagerCandidate(executable, {
                requiresPython: '<3.14.0rc130,!=3.14.0rc0',
            });
            assert.strictEqual(result?.version.toString(), '3.14.0rc1');
            verify();
        });
    });

    suite('bounded search', () => {
        test('rejects release components beyond the supported historical range before generating tag batches', async () => {
            list.resolves([runtime('3.14.1001')]);
            await assert.rejects(
                resolvePymanagerCandidate(executable, { requiresPython: '<3.14.1001' }),
                isBudgetError,
            );
            sinon.assert.calledOnce(list);
        });

        test('rejects unsupported prerelease serial ranges before allocating a history batch', async () => {
            const verify = catalogue([
                { selectors: [], runtimes: [runtime('3.14.7')] },
                { selectors: [tag('3.14.0rc')], runtimes: [runtime('3.14.0rc1001')] },
            ]);
            await assert.rejects(
                resolvePymanagerCandidate(executable, { requiresPython: '<3.14.0rc3' }),
                isBudgetError,
            );
            verify();
        });

        test('caps total native queries at 64 including the initial catalogue', async () => {
            const versions = ['3.20.1000', '3.19.1000', '3.18.1000', '3.17.1000'];
            list.resolves([]);
            list.onFirstCall().resolves(versions.map((version) => runtime(version)));
            await assert.rejects(
                resolvePymanagerCandidate(executable, { requiresPython: versions.map((version) => `!=${version}`).join(',') }),
                isBudgetError,
            );
            assert.strictEqual(list.callCount, 64);
            assert.deepStrictEqual(list.firstCall.args[1]?.selectors, []);
            for (const call of list.getCalls().slice(1)) {
                assert.ok((call.args[1]?.selectors?.length ?? 0) <= 64);
            }
        });

        test('stops before another native query once the elapsed historical-search budget is exhausted', async () => {
            const clock = sinon.useFakeTimers({ toFake: ['Date'] });
            list.callsFake(async () => {
                clock.tick(120001);
                return [runtime('3.14.7')];
            });
            await assert.rejects(
                resolvePymanagerCandidate(executable, { requiresPython: '<3.14.7' }),
                isBudgetError,
            );
            sinon.assert.calledOnce(list);
            assert.strictEqual(clock.countTimers(), 0);
        });

        test('allows a later independent attempt after a previous query exhausted its time budget', async () => {
            const clock = sinon.useFakeTimers({ toFake: ['Date'] });
            list.onFirstCall().callsFake(async () => {
                clock.tick(120001);
                return [runtime('3.14.7')];
            });
            await assert.rejects(
                resolvePymanagerCandidate(executable, { requiresPython: '<3.14.7' }),
                isBudgetError,
            );
            list.onSecondCall().resolves([runtime('3.14.6')]);
            assert.strictEqual(
                (await resolvePymanagerCandidate(executable, { version: '3.14.6' }))?.version.toString(),
                '3.14.6',
            );
            assert.strictEqual(list.callCount, 2);
        });
    });
});
