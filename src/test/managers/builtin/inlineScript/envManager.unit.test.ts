// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentChangeKind, EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../../api';
import * as cacheKey from '../../../../common/inlineScript/cacheKey';
import * as cacheLayout from '../../../../common/inlineScript/cacheLayout';
import * as metadataReader from '../../../../common/inlineScript/metadata';
import * as lockfileApis from '../../../../common/lockfile.apis';
import * as persistentState from '../../../../common/persistentState';
import { EventNames } from '../../../../common/telemetry/constants';
import * as telemetrySender from '../../../../common/telemetry/sender';
import { isWindows } from '../../../../common/utils/platformUtils';
import { normalizePath } from '../../../../common/utils/pathUtils';
import { getVenvPythonPath } from '../../../../common/utils/virtualEnvironment';
import {
    InlineScriptEnvManager,
    INLINE_SCRIPT_ENVS_KEY,
} from '../../../../managers/builtin/inlineScript/envManager';
import * as builtinUtils from '../../../../managers/builtin/utils';
import * as uvPythonInstaller from '../../../../managers/builtin/uvPythonInstaller';
import * as venvUtils from '../../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../../managers/common/nativePythonFinder';

const CACHE_KEY = '0123456789abcdef';
const NOW = new Date('2026-07-21T12:00:00.000Z');
const VALID_METADATA: metadataReader.InlineScriptMetadata = {
    requiresPython: '>=3.11',
    dependencies: ['requests'],
    range: { start: 0, end: 40 },
};

function makeFakeLog(): LogOutputChannel {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
        trace: sinon.stub(),
        show: sinon.stub(),
        dispose: sinon.stub(),
        append: sinon.stub(),
        appendLine: sinon.stub(),
        replace: sinon.stub(),
        clear: sinon.stub(),
        hide: sinon.stub(),
    } as unknown as LogOutputChannel;
}

function makeEnvironment(
    managerId: string,
    version: string,
    executable: string,
    sysPrefix: string = path.dirname(executable),
    name: string = `Python ${version}`,
): PythonEnvironment {
    return {
        envId: { id: `${managerId}-${version}-${executable}`, managerId },
        name,
        displayName: `Python ${version}`,
        displayPath: executable,
        version,
        environmentPath: Uri.file(executable),
        execInfo: { run: { executable } },
        sysPrefix,
    };
}

function makeUvPythonVersion(version: string): uvPythonInstaller.UvPythonVersion {
    const [major, minor, patch] = version.match(/\d+/g)!.map(Number);
    return {
        key: `cpython-${version}`,
        version,
        version_parts: { major, minor, patch },
        path: null,
        url: null,
        os: 'windows',
        variant: 'default',
        implementation: 'cpython',
        arch: 'x86_64',
    };
}

const venvPythonPath = getVenvPythonPath;

suite('InlineScriptEnvManager', () => {
    let api: PythonEnvironmentApi;
    let apiGetEnvironmentsStub: sinon.SinonStub;
    let apiRefreshEnvironmentsStub: sinon.SinonStub;
    let baseEnvironment: PythonEnvironment;
    let baseExecutable: string;
    let baseManager: EnvironmentManager;
    let computeCacheKeyStub: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;
    let createWithProgressStub: sinon.SinonStub;
    let getAvailablePythonVersionsStub: sinon.SinonStub;
    let ensureUvForVersionLookupStub: sinon.SinonStub;
    let globalStorageUri: Uri;
    let lockStub: sinon.SinonStub;
    let manager: InlineScriptEnvManager;
    let nativeFinder: NativePythonFinder;
    let promptInstallPythonViaUvStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;
    let inspectMetaStub: sinon.SinonStub;
    let retainLockStub: sinon.SinonStub;
    let releaseLockStub: sinon.SinonStub;
    let resolveSystemPythonStub: sinon.SinonStub;
    let resolveVenvStub: sinon.SinonStub;
    let tempRoot: string;
    let baseInterpreterStatusStub: sinon.SinonStub;
    let writeMetaStub: sinon.SinonStub;
    let workspaceState: {
        get: sinon.SinonStub;
        set: sinon.SinonStub;
        clear: sinon.SinonStub;
    };
    let persistedAssociations: unknown;

    setup(async () => {
        tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inline-script-manager-')));
        globalStorageUri = Uri.file(path.join(tempRoot, 'global-storage'));
        baseExecutable = path.join(tempRoot, 'base-python', isWindows() ? 'python.exe' : 'python');
        await fs.outputFile(baseExecutable, '');
        baseEnvironment = makeEnvironment('ms-python.python:system', '3.12.4', baseExecutable);

        apiGetEnvironmentsStub = sinon.stub().resolves([baseEnvironment]);
        apiRefreshEnvironmentsStub = sinon.stub().resolves();
        api = {
            getEnvironments: apiGetEnvironmentsStub,
            refreshEnvironments: apiRefreshEnvironmentsStub,
        } as unknown as PythonEnvironmentApi;
        nativeFinder = {} as NativePythonFinder;
        baseManager = {} as EnvironmentManager;
        persistedAssociations = undefined;
        workspaceState = {
            get: sinon.stub().callsFake(async (key: string) => {
                return key === INLINE_SCRIPT_ENVS_KEY ? persistedAssociations : undefined;
            }),
            set: sinon.stub().callsFake(async (key: string, value: unknown) => {
                if (key === INLINE_SCRIPT_ENVS_KEY) {
                    persistedAssociations = value;
                }
            }),
            clear: sinon.stub().callsFake(async (keys?: string[]) => {
                if (!keys || keys.includes(INLINE_SCRIPT_ENVS_KEY)) {
                    persistedAssociations = undefined;
                }
            }),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(workspaceState);

        readMetadataStub = sinon.stub(metadataReader, 'readInlineScriptMetadataFromFile').resolves(VALID_METADATA);
        computeCacheKeyStub = sinon.stub(cacheKey, 'computeCacheKey').returns(CACHE_KEY);
        getAvailablePythonVersionsStub = sinon.stub(uvPythonInstaller, 'getAvailablePythonVersions').resolves([]);
        ensureUvForVersionLookupStub = sinon
            .stub(uvPythonInstaller, 'ensureUvForInlineScriptVersionLookupDetailed')
            .resolves('available');
        promptInstallPythonViaUvStub = sinon
            .stub(uvPythonInstaller, 'promptInstallPythonViaUvDetailed')
            .resolves({ kind: 'declined' });
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
        inspectMetaStub = sinon.stub(cacheLayout, 'inspectMetaJson').resolves({ kind: 'missing' });
        baseInterpreterStatusStub = sinon.stub(cacheLayout, 'getBaseInterpreterStatus').resolves('available');
        writeMetaStub = sinon.stub(cacheLayout, 'writeMetaJson').resolves();
        retainLockStub = sinon.stub().resolves();
        releaseLockStub = sinon.stub().resolves();
        lockStub = sinon
            .stub(lockfileApis, 'acquireFileLock')
            .resolves({ release: releaseLockStub, retain: retainLockStub });
        resolveSystemPythonStub = sinon.stub(builtinUtils, 'resolveSystemPythonEnvironmentPath').resolves(undefined);
        resolveVenvStub = sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);
        createWithProgressStub = sinon.stub(venvUtils, 'createWithProgress').callsFake(async (...args: unknown[]) => {
            const envDir = args[6] as string;
            const selectedBase = args[4] as PythonEnvironment;
            await fs.outputFile(getVenvPythonPath(envDir), '');
            return {
                environment: makeEnvironment(
                    'ms-python.python:inline-script',
                    selectedBase.version,
                    getVenvPythonPath(envDir),
                    envDir,
                ),
            };
        });

        clock = sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
        manager = new InlineScriptEnvManager(nativeFinder, api, baseManager, globalStorageUri, makeFakeLog());
    });

    teardown(async () => {
        manager.dispose();
        sinon.restore();
        await fs.remove(tempRoot);
    });

    function scriptUri(name = 'script.py'): Uri {
        return Uri.file(path.join(tempRoot, name));
    }

    function envDir(): Uri {
        return cacheLayout.getScriptEnvDir(globalStorageUri, CACHE_KEY);
    }

    function setSidecar(metadata: cacheLayout.InlineScriptEnvMeta): void {
        inspectMetaStub.resolves({ kind: 'valid', metadata });
    }

    async function makeSidecar(
        overrides: Partial<cacheLayout.InlineScriptEnvMeta> = {},
    ): Promise<cacheLayout.InlineScriptEnvMeta> {
        return {
            schemaVersion: cacheLayout.META_SCHEMA_VERSION,
            baseInterpreterPath: await fs.realpath(baseExecutable),
            baseInterpreterVersion: baseEnvironment.version,
            lastUsedAt: NOW.toISOString(),
            ...overrides,
        };
    }

    function setSidecarResults(results: Record<string, cacheLayout.InlineScriptMetaReadResult>): void {
        inspectMetaStub.callsFake(async (candidate: Uri) => results[path.basename(candidate.fsPath)] ?? { kind: 'missing' });
    }

    function setResolvedVenvs(environments: readonly PythonEnvironment[]): void {
        const byPath = new Map(environments.map((environment) => [normalizePath(environment.environmentPath.fsPath), environment]));
        resolveVenvStub.callsFake(async (candidatePath: string) => byPath.get(normalizePath(candidatePath)));
    }

    async function createOwnedEnvironment(
        cacheKey: string = CACHE_KEY,
        envId: string = `inline-${cacheKey}`,
    ): Promise<PythonEnvironment> {
        const location = cacheLayout.getScriptEnvDir(globalStorageUri, cacheKey).fsPath;
        const executable = getVenvPythonPath(location);
        await fs.outputFile(executable, '');
        return {
            ...makeEnvironment('ms-python.python:inline-script', '3.12.4', executable, location),
            envId: { managerId: 'ms-python.python:inline-script', id: envId },
        };
    }

    async function waitForStubCall(stub: sinon.SinonStub): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (stub.called) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail('Expected the stub to be called');
    }

    async function waitForStubCallCount(stub: sinon.SinonStub, expectedCallCount: number): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (stub.callCount >= expectedCallCount) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail(`Expected the stub to be called ${expectedCallCount} times`);
    }

    async function waitForCondition(
        predicate: () => boolean | Promise<boolean>,
        message: string,
    ): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (await predicate()) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail(message);
    }

    function nextTurn(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    suite('static metadata and deferred methods', () => {
        test('exposes creation but leaves later-phase methods empty', async () => {
            const asInterface: EnvironmentManager = manager;
            assert.strictEqual(typeof asInterface.create, 'function');
            assert.strictEqual(asInterface.remove, undefined);
            assert.strictEqual(asInterface.quickCreateConfig, undefined);
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(await manager.get(scriptUri()), undefined);
            assert.strictEqual(await manager.resolve(scriptUri()), undefined);
        });

        test('retains inline-script manager presentation metadata', () => {
            assert.strictEqual(manager.name, 'inline-script');
            assert.ok(manager.displayName);
            assert.strictEqual(manager.preferredPackageManagerId, 'ms-python.python:pip');
            assert.ok(manager.iconPath);
            assert.ok(manager.tooltip);
        });
    });

    suite('scope and metadata validation', () => {
        test('rejects global, empty, multiple, and non-file scopes without reading metadata', async () => {
            assert.strictEqual(await manager.create('global'), undefined);
            assert.strictEqual(await manager.create([]), undefined);
            assert.strictEqual(await manager.create([scriptUri('a.py'), scriptUri('b.py')]), undefined);
            assert.strictEqual(await manager.create(Uri.parse('untitled:script.py')), undefined);
            assert.strictEqual(readMetadataStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });

        test('accepts a singleton URI array', async () => {
            const uri = scriptUri();
            const result = await manager.create([uri]);
            assert.ok(result);
            assert.ok(readMetadataStub.calledOnceWithExactly(uri));
        });

        test('returns undefined without cache mutation when metadata is absent', async () => {
            readMetadataStub.resolves(undefined);
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });

        test('rejects empty dependency entries before selecting or locking', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, dependencies: ['requests', '   '] });
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });
    });

    suite('base interpreter selection', () => {
        test('excludes derived managers even when they report newer global environments', async () => {
            const pipenv = makeEnvironment('ms-python.python:pipenv', '3.14.0', baseExecutable);
            apiGetEnvironmentsStub.resolves([pipenv, baseEnvironment]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
        });

        test('does not reapply release-only matching after strict PEP 440 filtering', async () => {
            const finalRelease = makeEnvironment('ms-python.python:system', '3.15.0', baseExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '!=3.15.0rc2' });
            apiGetEnvironmentsStub.resolves([finalRelease]);

            assert.ok(await manager.create(scriptUri()));

            assert.strictEqual(createWithProgressStub.firstCall.args[4], finalRelease);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
        });

        test('excludes named conda environments even when they are newer than conda base', async () => {
            const condaNamed = makeEnvironment(
                'ms-python.python:conda',
                '3.14.0',
                baseExecutable,
                undefined,
                'project-env',
            );
            const condaBase = makeEnvironment(
                'ms-python.python:conda',
                '3.11.9',
                baseExecutable,
                undefined,
                'base',
            );
            apiGetEnvironmentsStub.resolves([condaNamed, condaBase]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], condaBase);
        });

        test('falls back when the newest compatible interpreter cannot be canonicalized', async () => {
            const missingExecutable = path.join(tempRoot, 'missing', 'python');
            const newest = makeEnvironment('ms-python.python:system', '3.13.0', missingExecutable);
            apiGetEnvironmentsStub.resolves([baseEnvironment, newest]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
        });

        test('excludes pyenv virtual environments reported in global scope', async () => {
            const pyenvVenvRoot = path.join(tempRoot, 'pyenv', 'versions', 'project-env');
            const pyenvVenvExecutable = venvPythonPath(pyenvVenvRoot);
            await fs.outputFile(pyenvVenvExecutable, '');
            await fs.outputFile(path.join(pyenvVenvRoot, 'pyvenv.cfg'), 'home = base');
            const pyenvVenv = makeEnvironment(
                'ms-python.python:pyenv',
                '3.13.0',
                pyenvVenvExecutable,
                pyenvVenvRoot,
            );
            apiGetEnvironmentsStub.resolves([pyenvVenv, baseEnvironment]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
        });

        test('does not invoke creation when no installed base satisfies requires-python', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('skips base records with empty or relative sysPrefix values', async () => {
            const emptyPrefixExecutable = path.join(tempRoot, 'empty-prefix-python');
            const relativePrefixExecutable = path.join(tempRoot, 'relative-prefix-python');
            await fs.outputFile(emptyPrefixExecutable, '');
            await fs.outputFile(relativePrefixExecutable, '');
            apiGetEnvironmentsStub.resolves([
                makeEnvironment('ms-python.python:system', '3.14.0', emptyPrefixExecutable, ''),
                makeEnvironment('ms-python.python:system', '3.13.0', relativePrefixExecutable, 'relative-prefix'),
                baseEnvironment,
            ]);

            assert.ok(await manager.create(scriptUri()));
            sinon.assert.calledWith(computeCacheKeyStub, {
                dependencies: ['requests'],
                interpreterPath: await fs.realpath(baseExecutable),
            });
        });
    });

    suite('uv base interpreter fallback', () => {
        test('installs the requirement lower bound, refreshes, and uses the discovered base interpreter', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.13',
                version: '3.13',
            });
            sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 3);
            assert.strictEqual(createWithProgressStub.firstCall.args[4], uvBase);
        });

        test('asks uv for the latest Python when requires-python is absent', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.14.0', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: undefined });
            apiGetEnvironmentsStub.onFirstCall().resolves([]);
            apiGetEnvironmentsStub.onSecondCall().resolves([]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: undefined,
                version: undefined,
            });
            sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 3);
            assert.strictEqual(createWithProgressStub.firstCall.args[4], uvBase);
        });

        test('does not mutate the cache when the user declines installation', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            promptInstallPythonViaUvStub.resolves({ kind: 'declined' });

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(await fs.pathExists(cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath), false);
        });

        test('does not mutate the cache when installation fails', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            promptInstallPythonViaUvStub.rejects(new Error('uv failed'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('directly resolves the installed interpreter when environment refresh fails', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });
            apiRefreshEnvironmentsStub.rejects(new Error('discovery failed'));
            resolveSystemPythonStub.resolves(uvBase);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
            sinon.assert.calledOnceWithExactly(
                resolveSystemPythonStub,
                uvExecutable,
                nativeFinder,
                api,
                baseManager,
            );
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('directly resolves the installed interpreter when post-install discovery fails', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().rejects(new Error('discovery failed'));
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });
            resolveSystemPythonStub.resolves(uvBase);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(
                resolveSystemPythonStub,
                uvExecutable,
                nativeFinder,
                api,
                baseManager,
            );
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('selects an available uv release that satisfies exclusion clauses', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.3', uvExecutable);
            readMetadataStub.resolves({
                ...VALID_METADATA,
                requiresPython: '>=3.13.2,!=3.13.2',
            });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([
                {
                    key: 'cpython-3.13.2',
                    version: '3.13.2',
                    version_parts: { major: 3, minor: 13, patch: 2 },
                    path: null,
                    url: null,
                    os: 'windows',
                    variant: 'default',
                    implementation: 'cpython',
                    arch: 'x86_64',
                },
                {
                    key: 'cpython-3.13.3',
                    version: '3.13.3',
                    version_parts: { major: 3, minor: 13, patch: 3 },
                    path: null,
                    url: null,
                    os: 'windows',
                    variant: 'default',
                    implementation: 'cpython',
                    arch: 'x86_64',
                },
            ]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.13.2,!=3.13.2',
                version: '3.13.3',
            });
            assert.strictEqual(createWithProgressStub.firstCall.args[4], uvBase);
            sinon.assert.calledOnceWithExactly(
                ensureUvForVersionLookupStub,
                '>=3.13.2,!=3.13.2',
                manager.log,
            );
        });

        test('uses an explicit patch release when a minor selector could exceed the constraint', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.0', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13,<=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([
                makeUvPythonVersion('3.13.3'),
                makeUvPythonVersion('3.13.0'),
            ]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.13,<=3.13',
                version: '3.13.0',
            });
        });

        test('uses an advertised release for a bounded range instead of fabricating patch zero', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.11.14', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.11,<3.12' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([makeUvPythonVersion('3.11.14')]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.11,<3.12',
                version: '3.11.14',
            });
        });

        test('uses an exact requirement without needing an existing uv catalog', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '==3.13.1' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '==3.13.1',
                version: '3.13.1',
            });
            assert.strictEqual(getAvailablePythonVersionsStub.callCount, 0);
        });

        test('does not select a uv prerelease unless requires-python permits it', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.14.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.14,<3.16' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([
                makeUvPythonVersion('3.15.0a6'),
                makeUvPythonVersion('3.14.2'),
            ]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.14,<3.16',
                version: '3.14.2',
            });
        });

        test('installs an explicitly permitted prerelease lower bound', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.15.0a1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.15.0a1,<3.16' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.15.0a1,<3.16',
                version: '3.15.0a1',
            });
        });

        test('normalizes a PEP 440 prerelease alias before installation', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.15.0rc1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '==3.15.0c1' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '==3.15.0c1',
                version: '3.15.0rc1',
            });
        });

        test('does not prompt when requires-python has no safe lower bound', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '<3.13' });
            apiGetEnvironmentsStub.resolves([
                makeEnvironment('ms-python.python:system', '3.13.0', baseExecutable),
            ]);

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        for (const [description, refreshedEnvironments] of [
            ['the installed interpreter is not compatible', [baseEnvironment]],
            ['no installed interpreter is reported', []],
        ] as const) {
            test(`does not build when ${description} after refresh`, async () => {
                readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
                apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
                apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
                apiGetEnvironmentsStub.onThirdCall().resolves(refreshedEnvironments);
                promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: baseExecutable });

                assert.strictEqual(await manager.create(scriptUri()), undefined);

                sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
                assert.strictEqual(lockStub.callCount, 0);
                assert.strictEqual(createWithProgressStub.callCount, 0);
            });
        }

        test('does not prompt when a compatible installed interpreter is available', async () => {
            assert.ok(await manager.create(scriptUri()));

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
        });

        test('does not prompt during quick create', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);

            assert.strictEqual(await manager.create(scriptUri(), { quickCreate: true }), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });

        test('coalesces the full concurrent setup for the same script', async () => {
            const uri = scriptUri();
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            let installed = false;
            apiGetEnvironmentsStub.callsFake(async () => (installed ? [uvBase] : [baseEnvironment]));
            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                installed = true;
                return { kind: 'installed', pythonPath: uvExecutable };
            });

            const first = manager.create(uri);
            await promptShown;
            const second = manager.create(uri);
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('coalesces concurrent setup requests for the same script when installation is declined', async () => {
            const uri = scriptUri();
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            let finishPrompt: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(
                () =>
                    new Promise<{ kind: 'declined' }>((resolve) => {
                        signalPrompt!();
                        finishPrompt = () => resolve({ kind: 'declined' });
                    }),
            );

            const first = manager.create(uri);
            await promptShown;
            const second = manager.create(uri);
            finishPrompt!();
            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('coalesces simultaneous fallback requests for the same Python version', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });

            let isInstalled = false;
            let initialQueries = 0;
            let signalSecondInitialQuery: (() => void) | undefined;
            const secondInitialQuery = new Promise<void>((resolve) => {
                signalSecondInitialQuery = resolve;
            });
            apiGetEnvironmentsStub.callsFake(async () => {
                if (isInstalled) {
                    return [uvBase];
                }
                initialQueries += 1;
                if (initialQueries === 2) {
                    signalSecondInitialQuery!();
                }
                return [];
            });

            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                isInstalled = true;
                return { kind: 'installed', pythonPath: uvExecutable };
            });

            const first = manager.create(scriptUri('a.py'));
            await promptShown;
            const second = manager.create(scriptUri('b.py'));
            await secondInitialQuery;
            await Promise.resolve();
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('reuses a compatible installation for a queued request with a different lower bound', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.callsFake(async (uri: Uri) => ({
                ...VALID_METADATA,
                requiresPython: uri.fsPath.endsWith('compatible.py') ? '~=3.13.0' : '>=3.13',
            }));

            let installed = false;
            let queryCount = 0;
            let signalQueuedQuery: (() => void) | undefined;
            const queuedQuery = new Promise<void>((resolve) => {
                signalQueuedQuery = resolve;
            });
            apiGetEnvironmentsStub.callsFake(async () => {
                queryCount += 1;
                if (queryCount === 3) {
                    signalQueuedQuery!();
                }
                return installed ? [uvBase] : [];
            });

            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                installed = true;
                return { kind: 'installed', pythonPath: uvExecutable };
            });

            const first = manager.create(scriptUri('lower-bound.py'));
            await promptShown;
            const second = manager.create(scriptUri('compatible.py'));
            await queuedQuery;
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('reuses a directly resolved installation when discovery remains stale', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            resolveSystemPythonStub.resolves(uvBase);

            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                return { kind: 'installed', pythonPath: uvExecutable };
            });

            const first = manager.create(scriptUri('first.py'));
            await promptShown;
            const second = manager.create(scriptUri('second.py'));
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(resolveSystemPythonStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('reuses a directly resolved installation when later discovery throws', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onCall(3).rejects(new Error('discovery unavailable'));
            resolveSystemPythonStub.resolves(uvBase);
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });

            assert.ok(await manager.create(scriptUri('first.py')));
            assert.ok(await manager.create(scriptUri('second.py')));

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(resolveSystemPythonStub.callCount, 1);
        });
    });

    suite('cache creation', () => {
        test('hashes and installs metadata plus additional packages, then writes the sidecar', async () => {
            const result = await manager.create(scriptUri(), { additionalPackages: ['pytest'] });

            assert.ok(result);
            assert.deepStrictEqual(computeCacheKeyStub.firstCall.args[0], {
                dependencies: ['requests', 'pytest'],
                interpreterPath: baseExecutable,
            });
            assert.strictEqual(createWithProgressStub.firstCall.args[0], nativeFinder);
            assert.strictEqual(createWithProgressStub.firstCall.args[1], api);
            assert.strictEqual(createWithProgressStub.firstCall.args[3], manager);
            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
            assert.strictEqual(createWithProgressStub.firstCall.args[5].fsPath, cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath);
            assert.strictEqual(createWithProgressStub.firstCall.args[6], envDir().fsPath);
            assert.deepStrictEqual(createWithProgressStub.firstCall.args[7], {
                install: ['requests', 'pytest'],
                uninstall: [],
            });
            assert.deepStrictEqual(writeMetaStub.firstCall.args, [
                envDir(),
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: baseExecutable,
                    baseInterpreterVersion: baseEnvironment.version,
                    lastUsedAt: NOW.toISOString(),
                },
            ]);
            assert.strictEqual(
                createWithProgressStub.firstCall.args[8],
                false,
                'inline-script cache entries must not be tracked as workspace uv environments',
            );
            assert.ok(releaseLockStub.calledOnce);
        });

        test('uses a bounded cross-process lock at the final cache path', async () => {
            await manager.create(scriptUri());

            assert.strictEqual(lockStub.firstCall.args[0], envDir().fsPath);
            const options = lockStub.firstCall.args[1];
            assert.ok(options.timeoutMs > 0);
            assert.ok(options.retryIntervalMs > 0);
        });

        test('coalesces simultaneous same-key creation within one extension host', async () => {
            let continueCreation: (() => void) | undefined;
            let creationStarted: (() => void) | undefined;
            let secondCallHashed: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                creationStarted = resolve;
            });
            const secondHashed = new Promise<void>((resolve) => {
                secondCallHashed = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                continueCreation = resolve;
            });
            computeCacheKeyStub.callsFake(() => {
                if (computeCacheKeyStub.callCount === 2) {
                    secondCallHashed!();
                }
                return CACHE_KEY;
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                creationStarted!();
                await gate;
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                };
            });

            const first = manager.create(scriptUri('a.py'));
            await started;
            const second = manager.create(scriptUri('b.py'));
            await secondHashed;
            continueCreation!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(lockStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('returns undefined without building when the cache lock cannot be acquired', async () => {
            lockStub.rejects(Object.assign(new Error('already locked'), { code: 'ELOCKED' }));
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });
    });

    suite('cache reuse', () => {
        test('returns a valid cached environment and refreshes lastUsedAt', async () => {
            await fs.ensureDir(envDir().fsPath);
            const sidecar: cacheLayout.InlineScriptEnvMeta = {
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: '2026-07-01T00:00:00.000Z',
            };
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            setSidecar(sidecar);
            resolveVenvStub.resolves(cached);

            const result = await manager.create(scriptUri());

            assert.strictEqual(result, cached);
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.ok(baseInterpreterStatusStub.calledOnceWithExactly(envDir()));
            assert.strictEqual(resolveVenvStub.firstCall.args[0], venvPythonPath(envDir().fsPath));
            assert.deepStrictEqual(writeMetaStub.firstCall.args, [
                envDir(),
                { ...sidecar, lastUsedAt: NOW.toISOString() },
            ]);
        });

        test('returns a valid hit even when the last-used timestamp cannot be updated', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: '2026-07-01T00:00:00.000Z',
            });
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(cached);
            writeMetaStub.rejects(new Error('read-only filesystem'));

            assert.strictEqual(await manager.create(scriptUri()), cached);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('preserves a valid cache entry when its environment cannot be resolved', async () => {
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(undefined);

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('removes and rebuilds a cache entry whose sidecar names another base', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: path.join(tempRoot, 'different-python'),
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });

            const result = await manager.create(scriptUri());

            assert.ok(result);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('rebuilds when the base version changed at the same canonical path', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: '3.11.9',
                lastUsedAt: NOW.toISOString(),
            });

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('preserves the entry when resolution returns an environment owned by another manager', async () => {
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:system',
                    '3.11.9',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('rebuilds an inline-owned entry whose resolved version is unparseable', async () => {
            await fs.outputFile(getVenvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    'Unknown',
                    getVenvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(await fs.pathExists(markerPath), false);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('rebuilds when the resolved environment no longer satisfies requires-python', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.10.0',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('rebuilds when the cached Python differs from the selected base but still satisfies the script', async () => {
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.11.9',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        for (const metadataKind of ['missing', 'invalid'] as const) {
            test(`rebuilds an existing cache entry when metadata is ${metadataKind}`, async () => {
                const markerPath = path.join(envDir().fsPath, 'keep.txt');
                await fs.outputFile(markerPath, 'keep');
                inspectMetaStub.resolves({ kind: metadataKind });

                assert.ok(await manager.create(scriptUri()));
                assert.strictEqual(await fs.pathExists(markerPath), false);
                assert.strictEqual(createWithProgressStub.callCount, 1);
                assert.strictEqual(writeMetaStub.callCount, 1);
            });
        }

        test('preserves an existing cache entry when metadata is unavailable', async () => {
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            inspectMetaStub.resolves({ kind: 'unavailable' });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('preserves an existing cache entry when metadata inspection rejects', async () => {
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            inspectMetaStub.rejects(new Error('transient read failure'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('preserves an existing cache entry when its base interpreter cannot be inspected', async () => {
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            baseInterpreterStatusStub.resolves('unavailable');

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('rebuilds an existing cache entry when its base interpreter is definitively missing', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            baseInterpreterStatusStub.resolves('missing');

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('does not inspect or modify an entry resolving outside the physical cache root', async function () {
            const cacheRoot = cacheLayout.getScriptEnvCacheRoot(globalStorageUri);
            const externalEnv = path.join(tempRoot, 'external-env');
            const markerPath = path.join(externalEnv, 'keep.txt');
            await fs.ensureDir(cacheRoot.fsPath);
            await fs.outputFile(markerPath, 'keep');
            try {
                await fs.symlink(externalEnv, envDir().fsPath, isWindows() ? 'junction' : 'dir');
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES') {
                    this.skip();
                    return;
                }
                throw error;
            }

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual((await fs.lstat(envDir().fsPath)).isSymbolicLink(), true);
            assert.strictEqual(inspectMetaStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('does not inspect or modify an entry aliasing another hash directory', async function () {
            const cacheRoot = cacheLayout.getScriptEnvCacheRoot(globalStorageUri);
            const otherEnv = path.join(cacheRoot.fsPath, 'fedcba9876543210');
            const markerPath = path.join(otherEnv, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            try {
                await fs.symlink(otherEnv, envDir().fsPath, isWindows() ? 'junction' : 'dir');
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES') {
                    this.skip();
                    return;
                }
                throw error;
            }

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual((await fs.lstat(envDir().fsPath)).isSymbolicLink(), true);
            assert.strictEqual(inspectMetaStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });
    });

    suite('transaction rollback', () => {
        test('retains the partial environment and lock when package installation is cancelled', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                    pkgInstallationErr: 'Canceled',
                    pkgInstallationCancelled: true,
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), true);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.ok(retainLockStub.calledOnce);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('keeps a failed lock-retain transition fail-closed', async () => {
            createWithProgressStub.resolves({
                environment: makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.12.4',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
                pkgInstallationErr: 'Canceled',
                pkgInstallationCancelled: true,
            });
            retainLockStub.rejects(Object.assign(new Error('retention failed'), { code: 'EACCES' }));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.ok(retainLockStub.calledOnce);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('removes the partial environment when package installation fails', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.ensureDir(target);
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                    pkgInstallationErr: 'network failure',
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('removes the new environment when sidecar writing fails', async () => {
            writeMetaStub.rejects(new Error('disk full'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('removes a partial environment when createWithProgress throws', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                await fs.ensureDir(args[6] as string);
                throw new Error('unexpected create failure');
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('rejects and removes a created environment with a different Python release', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.11.9',
                        venvPythonPath(target),
                        target,
                    ),
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('rejects and removes a created environment outside the expected cache directory', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                const otherRoot = path.join(tempRoot, 'unexpected-env');
                const otherPython = venvPythonPath(otherRoot);
                await fs.outputFile(venvPythonPath(target), '');
                await fs.outputFile(otherPython, '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        otherPython,
                        otherRoot,
                    ),
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });
    });

    suite('activation-time discovery', () => {
        test('cold-start transient resolution retries and later discovers the environment', async () => {
            const environment = await createOwnedEnvironment();
            const sidecar = await makeSidecar();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            resolveVenvStub.onFirstCall().resolves(undefined);
            resolveVenvStub.onSecondCall().resolves(environment);
            const retryManager = manager as unknown as {
                getDiscoveryRetryDelayMs(attempt: number): number | undefined;
            };
            sinon.stub(retryManager, 'getDiscoveryRetryDelayMs').callsFake((attempt) => (attempt === 0 ? 0 : undefined));
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);

            manager.startActivationDiscovery();

            await waitForStubCallCount(resolveVenvStub, 2);
            await waitForCondition(
                async () => (await manager.getEnvironments('all')).length === 1,
                'Expected the follow-up discovery retry to publish the environment',
            );
            assert.deepStrictEqual(await manager.getEnvironments('all'), [environment]);
            assert.deepStrictEqual(listener.firstCall.args[0], [
                { kind: EnvironmentChangeKind.add, environment },
            ]);
        });

        test('refresh discovers valid cached environments and exposes them only through all-scope', async () => {
            const first = await createOwnedEnvironment();
            const secondKey = 'fedcba9876543210';
            const second = await createOwnedEnvironment(secondKey);
            const sidecar = await makeSidecar();
            setSidecarResults({
                [CACHE_KEY]: { kind: 'valid', metadata: sidecar },
                [secondKey]: { kind: 'valid', metadata: sidecar },
            });
            setResolvedVenvs([first, second]);
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);

            await manager.refresh(undefined);

            const discovered = await manager.getEnvironments('all');
            assert.deepStrictEqual(
                discovered.map((environment) => normalizePath(environment.sysPrefix)).sort(),
                [first, second].map((environment) => normalizePath(environment.sysPrefix)).sort(),
            );
            assert.deepStrictEqual(await manager.getEnvironments('global'), []);
            assert.strictEqual(listener.callCount, 1);
            assert.deepStrictEqual(
                listener.firstCall.args[0].map((change: { kind: EnvironmentChangeKind }) => change.kind),
                [EnvironmentChangeKind.add, EnvironmentChangeKind.add],
            );
        });

        test('refresh skips missing, invalid, unavailable, and non-directory cache entries', async () => {
            const valid = await createOwnedEnvironment();
            const cacheRoot = cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath;
            const invalidKey = 'invalid-sidecar';
            const unavailableKey = 'unavailable-sidecar';
            await fs.ensureDir(path.join(cacheRoot, 'missing-sidecar'));
            await fs.ensureDir(path.join(cacheRoot, invalidKey));
            await fs.ensureDir(path.join(cacheRoot, unavailableKey));
            await fs.outputFile(path.join(cacheRoot, 'not-a-directory'), '');
            const sidecar = await makeSidecar();
            setSidecarResults({
                [CACHE_KEY]: { kind: 'valid', metadata: sidecar },
                [invalidKey]: { kind: 'invalid' },
                [unavailableKey]: { kind: 'unavailable' },
            });
            setResolvedVenvs([valid]);

            await manager.refresh(undefined);

            const discovered = await manager.getEnvironments('all');
            assert.deepStrictEqual(discovered, [valid]);
            assert.strictEqual(resolveVenvStub.callCount, 1);
        });

        test('refresh preserves a previously discovered environment while its cache entry is locked', async () => {
            const environment = await createOwnedEnvironment();
            const sidecar = await makeSidecar();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            setResolvedVenvs([environment]);
            await manager.refresh(undefined);
            resolveVenvStub.resetHistory();
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);
            await fs.remove(environment.sysPrefix);
            await fs.ensureDir(`${path.resolve(environment.sysPrefix)}.lock`);

            await manager.refresh(undefined);

            assert.deepStrictEqual(await manager.getEnvironments('all'), [environment]);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.strictEqual(listener.callCount, 0);
        });

        test('refresh removes a previously discovered environment when launcher inspection marks it missing', async () => {
            const environment = await createOwnedEnvironment();
            const sidecar = await makeSidecar();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            setResolvedVenvs([environment]);
            await manager.refresh(undefined);
            resolveVenvStub.resetHistory();
            baseInterpreterStatusStub.resolves('missing');
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);

            await manager.refresh(undefined);

            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.deepStrictEqual(listener.firstCall.args[0], [
                { kind: EnvironmentChangeKind.remove, environment },
            ]);
        });

        test('coalesces concurrent refresh requests for the same scan', async () => {
            const environment = await createOwnedEnvironment();
            const sidecar = await makeSidecar();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            let resolveDiscovery: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveDiscovery = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);

            const firstRefresh = manager.refresh(undefined);
            const secondRefresh = manager.refresh(undefined);
            await waitForStubCall(resolveVenvStub);
            assert.strictEqual(resolveVenvStub.callCount, 1);
            resolveDiscovery!(environment);
            await Promise.all([firstRefresh, secondRefresh]);

            assert.deepStrictEqual(await manager.getEnvironments('all'), [environment]);
            assert.strictEqual(listener.callCount, 1);
        });

        test('explicit refresh does not schedule a delayed follow-up after an uncertain pass', async () => {
            const sidecar = await makeSidecar();
            await createOwnedEnvironment();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            resolveVenvStub.resolves(undefined);
            const retryManager = manager as unknown as {
                getDiscoveryRetryDelayMs(attempt: number): number | undefined;
            };
            sinon.stub(retryManager, 'getDiscoveryRetryDelayMs').returns(0);

            await manager.refresh(undefined);
            await new Promise((resolve) => setTimeout(resolve, 25));

            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
        });

        test('explicit refresh overlapping bootstrap cancels the later activation retry', async () => {
            const sidecar = await makeSidecar();
            await createOwnedEnvironment();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            let resolveDiscovery: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.onFirstCall().callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveDiscovery = resolve;
                    }),
            );
            resolveVenvStub.onSecondCall().resolves(undefined);
            const retryManager = manager as unknown as {
                getDiscoveryRetryDelayMs(attempt: number): number | undefined;
            };
            sinon.stub(retryManager, 'getDiscoveryRetryDelayMs').returns(0);

            manager.startActivationDiscovery();
            await waitForStubCall(resolveVenvStub);

            const refresh = manager.refresh(undefined);
            resolveDiscovery!(undefined);
            await refresh;
            await new Promise((resolve) => setTimeout(resolve, 25));

            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
        });

        test('stops retrying after the bounded follow-up attempts', async () => {
            const sidecar = await makeSidecar();
            await createOwnedEnvironment();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            resolveVenvStub.resolves(undefined);
            const retryManager = manager as unknown as {
                getDiscoveryRetryDelayMs(attempt: number): number | undefined;
            };
            sinon.stub(retryManager, 'getDiscoveryRetryDelayMs').callsFake((attempt) => (attempt < 2 ? 0 : undefined));

            manager.startActivationDiscovery();
            await waitForStubCallCount(resolveVenvStub, 3);
            await new Promise((resolve) => setTimeout(resolve, 25));

            assert.strictEqual(resolveVenvStub.callCount, 3);
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
        });

        test('refresh fires remove events when a discovered cache entry becomes invalid', async () => {
            const environment = await createOwnedEnvironment();
            let sidecarResult: cacheLayout.InlineScriptMetaReadResult = {
                kind: 'valid',
                metadata: await makeSidecar(),
            };
            inspectMetaStub.callsFake(async () => sidecarResult);
            setResolvedVenvs([environment]);
            await manager.refresh(undefined);
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);
            sidecarResult = { kind: 'invalid' };

            await manager.refresh(undefined);

            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(listener.callCount, 1);
            assert.deepStrictEqual(listener.firstCall.args[0], [
                { kind: EnvironmentChangeKind.remove, environment },
            ]);
        });

        test('does not publish discovery results after disposal while refresh is in flight', async () => {
            const environment = await createOwnedEnvironment();
            const sidecar = await makeSidecar();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            let resolveDiscovery: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveDiscovery = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironments(listener);

            const refresh = manager.refresh(undefined);
            await waitForStubCall(resolveVenvStub);
            manager.dispose();
            resolveDiscovery!(environment);
            await refresh;

            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(listener.callCount, 0);
        });

        test('dispose cancels a pending discovery retry', async () => {
            const sidecar = await makeSidecar();
            await createOwnedEnvironment();
            setSidecarResults({ [CACHE_KEY]: { kind: 'valid', metadata: sidecar } });
            resolveVenvStub.resolves(undefined);
            const retryManager = manager as unknown as {
                getDiscoveryRetryDelayMs(attempt: number): number | undefined;
            };
            sinon.stub(retryManager, 'getDiscoveryRetryDelayMs').returns(25);

            manager.startActivationDiscovery();
            await waitForStubCall(resolveVenvStub);
            manager.dispose();
            await new Promise((resolve) => setTimeout(resolve, 40));

            assert.strictEqual(resolveVenvStub.callCount, 1);
        });
    });

    suite('events and disposal', () => {
        test('create does not establish an association or fire later-phase events', async () => {
            const environmentsListener = sinon.spy();
            const environmentListener = sinon.spy();
            manager.onDidChangeEnvironments(environmentsListener);
            manager.onDidChangeEnvironment(environmentListener);

            assert.ok(await manager.create(scriptUri()));
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(await manager.get(scriptUri()), undefined);
            assert.strictEqual(environmentsListener.callCount, 0);
            assert.strictEqual(environmentListener.callCount, 0);
        });

        test('dispose is idempotent', () => {
            manager.dispose();
            assert.doesNotThrow(() => manager.dispose());
        });
    });

    suite('telemetry', () => {
        function telemetryCalls(eventName: EventNames): sinon.SinonSpyCall[] {
            return sendTelemetryStub.getCalls().filter((call) => call.args[0] === eventName);
        }

        function assertNoInlineScriptLifecycleTelemetry(): void {
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).length, 0);
        }

        test('does not emit lifecycle telemetry for non-applicable create calls', async () => {
            readMetadataStub.resolves(undefined);

            assert.strictEqual(await manager.create('global'), undefined);
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assertNoInlineScriptLifecycleTelemetry();
        });

        test('emits envCreated with only duration and dependencyCount after verified creation', async () => {
            assert.ok(await manager.create(scriptUri()));

            const createdCalls = telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED);
            assert.strictEqual(createdCalls.length, 1);
            assert.deepStrictEqual(createdCalls[0].args, [
                EventNames.INLINE_SCRIPT_ENV_CREATED,
                { duration: 0, dependencyCount: 1 },
            ]);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).length, 0);
        });

        test('deduplicates normalized dependencies for envCreated dependencyCount', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, dependencies: ['Requests', 'requests'] });

            assert.ok(await manager.create(scriptUri()));

            const createdCalls = telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED);
            assert.strictEqual(createdCalls.length, 1);
            assert.deepStrictEqual(createdCalls[0].args, [
                EventNames.INLINE_SCRIPT_ENV_CREATED,
                { duration: 0, dependencyCount: 1 },
            ]);
        });

        test('emits envReuseHit only for validated cache hits', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, dependencies: ['Requests', 'requests'] });
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(cached);

            assert.strictEqual(await manager.create(scriptUri()), cached);

            const reuseCalls = telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT);
            assert.strictEqual(reuseCalls.length, 1);
            assert.deepStrictEqual(reuseCalls[0].args, [
                EventNames.INLINE_SCRIPT_ENV_REUSE_HIT,
                { dependencyCount: 1 },
            ]);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).length, 0);
        });

        test('emits setup-failure when cache inspection is unavailable', async () => {
            await fs.ensureDir(envDir().fsPath);
            inspectMetaStub.resolves({ kind: 'unavailable' });

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'setup-failure' }]],
            );
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT).length, 0);
        });

        test('emits a single compatible-python-declined error for coalesced same-script requests', async () => {
            const uri = scriptUri();
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            let finishPrompt: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(
                () =>
                    new Promise<{ kind: 'declined' }>((resolve) => {
                        signalPrompt!();
                        finishPrompt = () => resolve({ kind: 'declined' });
                    }),
            );

            const first = manager.create(uri);
            await promptShown;
            const second = manager.create(uri);
            finishPrompt!();

            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'compatible-python-declined' }]],
            );
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT).length, 0);
        });

        test('emits no-compatible-python when quick create cannot prompt for a compatible interpreter', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);

            assert.strictEqual(await manager.create(scriptUri(), { quickCreate: true }), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'no-compatible-python' }]],
            );
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
        });

        test('emits discovery-failure when quick create cannot inspect discovered interpreters', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.rejects(new Error('discovery unavailable'));

            assert.strictEqual(await manager.create(scriptUri(), { quickCreate: true }), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'discovery-failure' }]],
            );
        });

        test('emits the final compatible-python-declined outcome when discovery was unavailable', async () => {
            const uri = scriptUri();
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.rejects(new Error('discovery unavailable'));

            assert.strictEqual(await manager.create(uri), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'compatible-python-declined' }]],
            );
        });

        test('emits the final install-failure outcome when discovery was unavailable', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.rejects(new Error('discovery unavailable'));
            promptInstallPythonViaUvStub.resolves({ kind: 'failed' });

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'install-failure' }]],
            );
        });

        test('emits discovery-failure when installed Python cannot be discovered or resolved', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.rejects(new Error('discovery unavailable'));
            promptInstallPythonViaUvStub.resolves({ kind: 'installed', pythonPath: uvExecutable });
            resolveSystemPythonStub.resolves(undefined);

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(resolveSystemPythonStub.callCount, 1);
            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'discovery-failure' }]],
            );
        });

        test('emits a single envCreated event for coalesced same-key creation', async () => {
            let continueCreation: (() => void) | undefined;
            let creationStarted: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                creationStarted = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                continueCreation = resolve;
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                creationStarted!();
                await gate;
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                };
            });

            const first = manager.create(scriptUri('a.py'));
            await started;
            const second = manager.create(scriptUri('b.py'));
            continueCreation!();

            const [firstResult, secondResult] = await Promise.all([first, second]);
            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 1);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).length, 0);
        });

        test('excludes lock and cache inspection time from envCreated duration', async () => {
            await fs.ensureDir(envDir().fsPath);
            lockStub.callsFake(async () => {
                clock.tick(3_000);
                return { release: releaseLockStub, retain: retainLockStub };
            });
            inspectMetaStub.callsFake(async () => {
                clock.tick(2_000);
                return { kind: 'missing' };
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                clock.tick(25);
                await fs.outputFile(venvPythonPath(target), '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                };
            });

            assert.ok(await manager.create(scriptUri()));

            const createdCalls = telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED);
            assert.strictEqual(createdCalls.length, 1);
            assert.deepStrictEqual(createdCalls[0].args, [
                EventNames.INLINE_SCRIPT_ENV_CREATED,
                { duration: 25, dependencyCount: 1 },
            ]);
        });

        test('emits lock-timeout when the cache lock cannot be acquired', async () => {
            lockStub.rejects(Object.assign(new Error('already locked'), { code: 'ELOCKED' }));

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'lock-timeout' }]],
            );
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
        });

        for (const code of ['ELOCKRETAINED', 'ELOCKORPHANED'] as const) {
            test(`emits lock-unavailable when cache lock acquisition fails with ${code}`, async () => {
                lockStub.rejects(Object.assign(new Error('lock unavailable'), { code }));

                assert.strictEqual(await manager.create(scriptUri()), undefined);

                assert.deepStrictEqual(
                    telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                    [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'lock-unavailable' }]],
                );
                assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
            });
        }

        test('emits package-install-cancelled and no success event on rollback', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                    pkgInstallationErr: 'Canceled',
                    pkgInstallationCancelled: true,
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'package-install-cancelled' }]],
            );
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
        });

        test('emits setup-failure when sidecar persistence rollback removes the new environment', async () => {
            writeMetaStub.rejects(new Error('disk full'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.deepStrictEqual(
                telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).map((call) => call.args),
                [[EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category: 'setup-failure' }]],
            );
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 0);
        });

        test('rebuilds a failed reuse validation as creation without counting a reuse hit', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.10.0',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));

            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_CREATED).length, 1);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT).length, 0);
            assert.strictEqual(telemetryCalls(EventNames.INLINE_SCRIPT_ENV_ERROR).length, 0);
        });
    });

    suite('script association persistence', () => {
        test('sets, gets, unsets, persists, and reports only actual selection changes', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, environment);

            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.firstCall.args[0], INLINE_SCRIPT_ENVS_KEY);
            assert.strictEqual(listener.callCount, 1);
            assert.deepStrictEqual(listener.firstCall.args[0], { uri, old: undefined, new: environment });

            await manager.set(uri, environment);
            assert.strictEqual(listener.callCount, 1);

            await manager.set(uri, undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(listener.callCount, 2);
            assert.deepStrictEqual(listener.secondCall.args[0], { uri, old: environment, new: undefined });
        });

        test('persists a batch atomically and reports each distinct script URI exactly once', async () => {
            const first = scriptUri('first.py');
            const second = scriptUri('second.py');
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set([first, second, first], environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(first.fsPath)]: environment.environmentPath.fsPath,
                [normalizePath(second.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 1);
            assert.strictEqual(listener.callCount, 2);
            assert.strictEqual(listener.firstCall.args[0].uri, first);
            assert.strictEqual(listener.secondCall.args[0].uri, second);
            assert.strictEqual(await manager.get(first), environment);
            assert.strictEqual(await manager.get(second), environment);
        });

        test('serializes concurrent selections so neither persisted association is lost', async () => {
            const firstUri = scriptUri('first.py');
            const secondUri = scriptUri('second.py');
            const firstEnvironment = await createOwnedEnvironment();
            const secondEnvironment = await createOwnedEnvironment('fedcba9876543210');

            await Promise.all([
                manager.set(firstUri, firstEnvironment),
                manager.set(secondUri, secondEnvironment),
            ]);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(firstUri.fsPath)]: firstEnvironment.environmentPath.fsPath,
                [normalizePath(secondUri.fsPath)]: secondEnvironment.environmentPath.fsPath,
            });
            assert.strictEqual(await manager.get(firstUri), firstEnvironment);
            assert.strictEqual(await manager.get(secondUri), secondEnvironment);
        });

        test('rehydrates a persisted owned association on demand after restart', async () => {
            const uri = scriptUri();
            const persistedEnvironment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: persistedEnvironment.environmentPath.fsPath };
            const rehydrated = { ...persistedEnvironment, envId: { ...persistedEnvironment.envId, id: 'rehydrated' } };
            resolveVenvStub.resolves(rehydrated);
            const restarted = new InlineScriptEnvManager(nativeFinder, api, baseManager, globalStorageUri, makeFakeLog());

            assert.strictEqual(await restarted.get(uri), rehydrated);
            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: persistedEnvironment.environmentPath.fsPath,
            });

            const listener = sinon.spy();
            restarted.onDidChangeEnvironment(listener);
            await restarted.set(uri, persistedEnvironment);
            assert.strictEqual(listener.callCount, 0, 'different generated IDs for the same executable are not a change');

            restarted.dispose();
        });

        test('preserves and retries a cold association when resolution rejects', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.onFirstCall().rejects(new Error('resolver unavailable'));
            resolveVenvStub.onSecondCall().resolves(environment);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('preserves and retries a cold association when ownership inspection rejects', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves(environment);
            const inspectionManager = manager as unknown as {
                inspectAssociationOwnership(
                    candidate: PythonEnvironment,
                ): Promise<'expected' | 'stale' | 'uncertain'>;
            };
            const ownershipStub = sinon.stub(inspectionManager, 'inspectAssociationOwnership').callThrough();
            ownershipStub.onFirstCall().rejects(new Error('filesystem unavailable'));

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('notifies when a slow persisted association finishes rehydrating', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            let resolveRehydration: ((value: PythonEnvironment) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment>((resolve) => {
                        resolveRehydration = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            const pending = manager.get(uri);
            await waitForStubCall(resolveVenvStub);
            assert.strictEqual(listener.callCount, 0);
            resolveRehydration!(environment);

            assert.strictEqual(await pending, environment);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: undefined, new: environment });
        });

        test('does not rewrite or notify when a restart reselects the same persisted executable', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            const restarted = new InlineScriptEnvManager(nativeFinder, api, baseManager, globalStorageUri, makeFakeLog());
            const listener = sinon.spy();
            restarted.onDidChangeEnvironment(listener);

            await restarted.set(uri, environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(listener.callCount, 0);
            assert.strictEqual(resolveVenvStub.callCount, 0);

            restarted.dispose();
        });

        test('does not return a retained association when current metadata no longer accepts its Python version', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '==3.11.*' });

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });

            readMetadataStub.resolves(VALID_METADATA);
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('uses full PEP 440 semantics when validating a retained association', async () => {
            const uri = scriptUri();
            const environment = {
                ...(await createOwnedEnvironment()),
                version: '3.15.0',
            };
            await manager.set(uri, environment);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '!=3.15.0rc2' });

            assert.strictEqual(await manager.get(uri), environment);
        });

        test('does not resolve or discard an association when metadata is absent or unreadable', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            readMetadataStub.resolves(undefined);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
        });

        test('preserves a cold persisted association while its cache entry is locked', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            const lockPath = `${path.resolve(environment.sysPrefix)}.lock`;
            await fs.ensureDir(lockPath);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(resolveVenvStub.callCount, 0);
        });

        test('removes and notifies for a warm association whose executable was deleted', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(environment.environmentPath.fsPath);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: undefined });
        });

        test('clears a case-variant persisted path when its warm executable is deleted', async function () {
            if (!isWindows()) {
                this.skip();
            }
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath.toUpperCase(),
            };
            resolveVenvStub.resolves(environment);
            assert.strictEqual(await manager.get(uri), environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(environment.environmentPath.fsPath);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            resolveVenvStub.resetHistory();
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: undefined });
        });

        test('preserves a warm association while its cache entry is locked', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(environment.environmentPath.fsPath);
            await fs.ensureDir(`${path.resolve(environment.sysPrefix)}.lock`);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(listener.callCount, 0);
        });

        test('refreshes a warm association rebuilt at the same cache path', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const rebuilt = {
                ...environment,
                envId: { ...environment.envId, id: 'rebuilt' },
                version: '3.13.1',
            };
            resolveVenvStub.resolves(rebuilt);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), rebuilt);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: rebuilt });
        });

        test('retains warm environment identity when validation finds the same version', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            resolveVenvStub.resolves({
                ...environment,
                envId: { ...environment.envId, id: 'new-generated-id' },
            });
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), environment);
            assert.strictEqual(listener.callCount, 0);
        });

        test('coalesces concurrent validation of an expired warm association', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const rebuilt = {
                ...environment,
                envId: { ...environment.envId, id: 'rebuilt' },
                version: '3.13.1',
            };
            let resolveValidation: ((value: PythonEnvironment) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment>((resolve) => {
                        resolveValidation = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            const first = manager.get(uri);
            const second = manager.get(uri);
            await waitForStubCall(resolveVenvStub);
            resolveValidation!(rebuilt);

            assert.deepStrictEqual(await Promise.all([first, second]), [rebuilt, rebuilt]);
            assert.strictEqual(resolveVenvStub.callCount, 1);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: rebuilt });
        });

        test('lets an explicit selection win while warm validation awaits filesystem inspection', async () => {
            const uri = scriptUri();
            const oldEnvironment = await createOwnedEnvironment();
            const selectedEnvironment = await createOwnedEnvironment('fedcba9876543210');
            await manager.set(uri, oldEnvironment);
            const rebuiltOldEnvironment = {
                ...oldEnvironment,
                envId: { ...oldEnvironment.envId, id: 'rebuilt-old' },
                version: '3.13.1',
            };
            resolveVenvStub.resolves(rebuiltOldEnvironment);
            let releaseBusyCheck: (() => void) | undefined;
            const busyCheckGate = new Promise<boolean>((resolve) => {
                releaseBusyCheck = () => resolve(false);
            });
            const validationManager = manager as unknown as {
                isCacheEntryBusy(envDirPath: string): Promise<boolean>;
            };
            const busyCheckStub = sinon.stub(validationManager, 'isCacheEntryBusy').callThrough();
            busyCheckStub.onFirstCall().returns(busyCheckGate);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            const pendingGet = manager.get(uri);
            await waitForStubCall(busyCheckStub);
            await manager.set(uri, selectedEnvironment);
            releaseBusyCheck!();

            assert.strictEqual(await pendingGet, selectedEnvironment);
            assert.strictEqual(await manager.get(uri), selectedEnvironment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: selectedEnvironment.environmentPath.fsPath,
            });
            assert.strictEqual(resolveVenvStub.callCount, 0);
            sinon.assert.calledOnceWithExactly(listener, {
                uri,
                old: oldEnvironment,
                new: selectedEnvironment,
            });
        });

        test('unsets a persisted association after transient rehydration failure', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves(undefined);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 1);

            await manager.set(uri, undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(listener.callCount, 1);

            resolveVenvStub.resetHistory();
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 0);
        });

        test('removes definitively stale or corrupt persisted paths but preserves transient resolution failures', async () => {
            const staleUri = scriptUri('stale.py');
            persistedAssociations = { [normalizePath(staleUri.fsPath)]: path.join(tempRoot, 'missing-python') };

            assert.strictEqual(await manager.get(staleUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});

            const corruptUri = scriptUri('corrupt.py');
            persistedAssociations = { [normalizePath(corruptUri.fsPath)]: 'not-an-absolute-path' };
            assert.strictEqual(await manager.get(corruptUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});

            const transientUri = scriptUri('transient.py');
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(transientUri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves(undefined);

            assert.strictEqual(await manager.get(transientUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(transientUri.fsPath)]: environment.environmentPath.fsPath,
            });

            persistedAssociations = ['corrupt state'];
            assert.strictEqual(await manager.get(scriptUri('corrupt-state.py')), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
        });

        test('does not let stale corrupt-state repair delete a newer valid association', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const scriptPath = normalizePath(uri.fsPath);
            persistedAssociations = { [scriptPath]: 42 };
            workspaceState.get.onSecondCall().callsFake(async () => {
                persistedAssociations = { [scriptPath]: environment.environmentPath.fsPath };
                return persistedAssociations;
            });

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [scriptPath]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
        });

        test('preserves an association when fallback resolution reports another manager', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves({
                ...environment,
                envId: { ...environment.envId, managerId: 'ms-python.python:system' },
            });

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
        });

        test('rejects resolved and selected environments that are outside the owned cache', async () => {
            const uri = scriptUri();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            const outsideDir = path.join(tempRoot, 'outside');
            const outsideExecutable = getVenvPythonPath(outsideDir);
            await fs.outputFile(outsideExecutable, '');
            await fs.ensureDir(cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath);
            const unowned = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                outsideExecutable,
                outsideDir,
            );
            persistedAssociations = { [normalizePath(uri.fsPath)]: outsideExecutable };
            resolveVenvStub.resolves(unowned);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            workspaceState.set.resetHistory();

            await assert.rejects(manager.set(uri, unowned), /not an owned cache entry/);
            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(listener.callCount, 0);
        });

        test('normalizes script paths and treats same-ID environments at different paths as different selections', async function () {
            if (!isWindows()) {
                this.skip();
            }
            const uri = scriptUri('CaseSensitive.py');
            const differentlyCased = Uri.file(uri.fsPath.toUpperCase());
            const first = await createOwnedEnvironment(CACHE_KEY, 'duplicate-id');
            const second = await createOwnedEnvironment('fedcba9876543210', 'duplicate-id');
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, first);
            assert.strictEqual(await manager.get(differentlyCased), first);

            await manager.set(differentlyCased, second);
            assert.strictEqual(await manager.get(uri), second);
            assert.strictEqual(listener.callCount, 2);
            assert.strictEqual(listener.secondCall.args[0].uri, differentlyCased);
            assert.strictEqual(listener.secondCall.args[0].old, first);
            assert.strictEqual(listener.secondCall.args[0].new, second);
        });

        test('keeps the prior in-memory association and emits no event when persistence fails', async () => {
            const uri = scriptUri();
            const first = await createOwnedEnvironment();
            const second = await createOwnedEnvironment('fedcba9876543210');
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, first);
            workspaceState.set.onSecondCall().rejects(new Error('Memento unavailable'));
            await assert.rejects(manager.set(uri, second), /Memento unavailable/);

            assert.strictEqual(await manager.get(uri), first);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: first.environmentPath.fsPath,
            });
            assert.strictEqual(listener.callCount, 1);
        });

        test('rejects a failed unset without changing its in-memory association or firing an event', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, environment);
            workspaceState.set.onSecondCall().rejects(new Error('Memento unavailable'));

            await assert.rejects(manager.set(uri, undefined), /Memento unavailable/);
            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(listener.callCount, 1);
        });

        test('does not block a cached lookup behind another script rehydration', async () => {
            const slowUri = scriptUri('slow.py');
            const cachedUri = scriptUri('cached.py');
            const slowEnvironment = await createOwnedEnvironment();
            const cachedEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = { [normalizePath(slowUri.fsPath)]: slowEnvironment.environmentPath.fsPath };
            await manager.set(cachedUri, cachedEnvironment);

            let resolveSlow: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveSlow = resolve;
                    }),
            );
            const slowGet = manager.get(slowUri);
            await waitForStubCall(resolveVenvStub);

            const cachedResult = await Promise.race([
                manager.get(cachedUri).then((value) => ({ kind: 'cached' as const, value })),
                nextTurn().then(() => ({ kind: 'blocked' as const, value: undefined })),
            ]);
            assert.strictEqual(cachedResult.kind, 'cached');
            assert.strictEqual(cachedResult.value, cachedEnvironment);

            resolveSlow!(slowEnvironment);
            assert.strictEqual(await slowGet, slowEnvironment);
        });

        test('lets an unset win over a pending stale rehydration', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };

            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);

            await manager.set(uri, undefined);
            assert.deepStrictEqual(persistedAssociations, {});

            resolvePending!(environment);
            assert.strictEqual(await pendingGet, undefined);
            assert.strictEqual(await manager.get(uri), undefined);
        });

        test('lets a same-path selection supersede a pending stale rehydration', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };

            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);

            await manager.set(uri, environment);
            const stale = {
                ...environment,
                envId: { ...environment.envId, managerId: 'ms-python.python:system' },
            };
            resolvePending!(stale);

            assert.strictEqual(await pendingGet, environment);
            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
        });

        test('retains a pending rehydration when a competing persistence write fails', async () => {
            const uri = scriptUri();
            const oldEnvironment = await createOwnedEnvironment();
            const newEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = { [normalizePath(uri.fsPath)]: oldEnvironment.environmentPath.fsPath };
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);

            workspaceState.set.onFirstCall().rejects(new Error('Memento unavailable'));
            await assert.rejects(manager.set(uri, newEnvironment), /Memento unavailable/);

            resolvePending!(oldEnvironment);
            assert.strictEqual(await pendingGet, oldEnvironment);
            assert.strictEqual(await manager.get(uri), oldEnvironment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: oldEnvironment.environmentPath.fsPath,
            });
            sinon.assert.calledOnceWithExactly(listener, { uri, old: undefined, new: oldEnvironment });
        });

        test('rejects invalid scopes atomically and never writes workspace state', async () => {
            const environment = await createOwnedEnvironment();
            const valid = scriptUri();

            await assert.rejects(manager.set(undefined, environment), /one or more local file URIs/);
            await assert.rejects(manager.set(Uri.parse('untitled:script.py'), environment), /one or more local file URIs/);
            await assert.rejects(
                manager.set([valid, Uri.parse('untitled:script.py')], environment),
                /one or more local file URIs/,
            );

            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(await manager.get(valid), undefined);
            assert.strictEqual(await manager.get(undefined), undefined);
            assert.strictEqual(await manager.get(Uri.parse('untitled:script.py')), undefined);
        });
    });

    suite('clear cache', () => {
        test('clears cached environments, persisted associations, and in-memory selections', async () => {
            const first = scriptUri('first.py');
            const second = scriptUri('second.py');
            const environment = await createOwnedEnvironment();
            await manager.set([first, second], environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.clearCache();

            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(persistedAssociations, undefined);
            assert.strictEqual(await manager.get(first), undefined);
            assert.strictEqual(await manager.get(second), undefined);
            assert.deepStrictEqual(
                listener.getCalls().map((call) => normalizePath(call.args[0].uri.fsPath)).sort(),
                [first.fsPath, second.fsPath].map((value) => normalizePath(value)).sort(),
            );
            assert.deepStrictEqual(
                listener.getCalls().map((call) => call.args[0].old),
                [environment, environment],
            );
            assert.ok(listener.getCalls().every((call) => call.args[0].new === undefined));
        });

        test('clears associations even when the cache directory is already missing', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath);

            await manager.clearCache();

            assert.strictEqual(persistedAssociations, undefined);
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(listener.callCount, 1);
            assert.strictEqual(normalizePath(listener.firstCall.args[0].uri.fsPath), normalizePath(uri.fsPath));
            assert.strictEqual(listener.firstCall.args[0].old, environment);
            assert.strictEqual(listener.firstCall.args[0].new, undefined);
        });

        test('is idempotent when the cache and associations are already absent', async () => {
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.clearCache();
            await manager.clearCache();

            assert.strictEqual(persistedAssociations, undefined);
            assert.strictEqual(listener.callCount, 0);
        });

        test('refuses to clear from an unsafe cache root', async function () {
            if (isWindows() && !process.env.SystemDrive) {
                this.skip();
            }
            const unsafeManager = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                Uri.file(process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/'),
                makeFakeLog(),
            );

            await assert.rejects(
                unsafeManager.clearCache(),
                /unsafe cache root/,
            );

            unsafeManager.dispose();
        });

        test('refuses to clear a symlinked cache root', async function () {
            const symlinkStorageUri = Uri.file(path.join(tempRoot, 'symlink-storage'));
            const symlinkManager = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                symlinkStorageUri,
                makeFakeLog(),
            );
            const realCacheRoot = cacheLayout.getScriptEnvCacheRoot(symlinkStorageUri).fsPath;
            const externalCacheRoot = path.join(tempRoot, 'external-cache-root');
            await fs.ensureDir(symlinkStorageUri.fsPath);
            await fs.ensureDir(externalCacheRoot);
            try {
                await fs.symlink(externalCacheRoot, realCacheRoot, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES') {
                    this.skip();
                }
                throw error;
            }

            await assert.rejects(
                symlinkManager.clearCache(),
                /not a normal directory/,
            );

            symlinkManager.dispose();
        });

        test('refuses to clear when globalStorage is redirected through a symlink or junction', async function () {
            const physicalStoragePath = path.join(tempRoot, 'physical-storage');
            const redirectedStoragePath = path.join(tempRoot, 'redirected-storage');
            await fs.ensureDir(physicalStoragePath);
            await fs.ensureDir(redirectedStoragePath);
            const redirectedManager = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                Uri.file(redirectedStoragePath),
                makeFakeLog(),
            );
            try {
                await fs.remove(redirectedStoragePath);
                await fs.symlink(
                    physicalStoragePath,
                    redirectedStoragePath,
                    process.platform === 'win32' ? 'junction' : 'dir',
                );
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES') {
                    this.skip();
                }
                throw error;
            }

            await assert.rejects(redirectedManager.clearCache(), /global storage root is not a normal directory/);

            redirectedManager.dispose();
        });

        test('fails closed when physical cache verification reports a redirected root', async () => {
            const internalManager = manager as unknown as {
                getPhysicalOwnedCacheRootPath(cacheRoot: Uri): Promise<string | undefined>;
            };
            const original = internalManager.getPhysicalOwnedCacheRootPath.bind(manager);
            internalManager.getPhysicalOwnedCacheRootPath = async () => {
                throw new Error('Refusing to clear the script environment cache because the cache root is redirected.');
            };
            try {
                await assert.rejects(manager.clearCache(), /cache root is redirected/);
            } finally {
                internalManager.getPhysicalOwnedCacheRootPath = original;
            }
        });

        test('refuses to clear while a cached environment is locked', async () => {
            lockStub.restore();
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const lockPath = lockfileApis.getFileLockPath(environment.sysPrefix);
            await fs.ensureDir(lockPath);
            await fs.writeFile(path.join(lockPath, `owner-${process.pid}-test`), '');

            await assert.rejects(manager.clearCache(), /being created/);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('clears a generation-specific retained lock and its corresponding cache entry', async () => {
            lockStub.restore();
            const retainedCacheDir = envDir().fsPath;
            await fs.outputFile(venvPythonPath(retainedCacheDir), '');
            const lock = await lockfileApis.acquireFileLock(retainedCacheDir, {
                timeoutMs: 0,
                retryIntervalMs: 1,
            });
            await lock.retain();

            await manager.clearCache();

            assert.strictEqual(await fs.pathExists(retainedCacheDir), false);
            assert.strictEqual(await fs.pathExists(lockfileApis.getFileLockPath(retainedCacheDir)), false);
        });

        test('refuses to clear a legacy retained lock conservatively', async () => {
            lockStub.restore();
            const retainedCacheDir = envDir().fsPath;
            const retainedLockPath = lockfileApis.getFileLockPath(retainedCacheDir);
            await fs.outputFile(venvPythonPath(retainedCacheDir), '');
            await fs.ensureDir(retainedLockPath);
            await fs.writeFile(path.join(retainedLockPath, 'retained'), '');

            await assert.rejects(manager.clearCache(), /incomplete or malformed/);

            assert.strictEqual(await fs.pathExists(retainedCacheDir), true);
            assert.strictEqual(await fs.pathExists(retainedLockPath), true);
        });

        test('clears a stale owner lock and its corresponding cache entry', async () => {
            lockStub.restore();
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const staleLockPath = lockfileApis.getFileLockPath(environment.sysPrefix);
            await fs.ensureDir(staleLockPath);
            await fs.writeFile(path.join(staleLockPath, 'owner-424242-dead'), '');
            const originalInspectFileLock = lockfileApis.inspectFileLock;
            sinon.stub(lockfileApis, 'inspectFileLock').callsFake(async (filePath, options) => {
                if (normalizePath(filePath) === normalizePath(environment.sysPrefix)) {
                    return 'stale';
                }
                return originalInspectFileLock(filePath, options);
            });

            await manager.clearCache();

            assert.strictEqual(await fs.pathExists(environment.sysPrefix), false);
            assert.strictEqual(await fs.pathExists(staleLockPath), false);
            assert.strictEqual(await manager.get(uri), undefined);
        });

        test('does not delete an entry when another host acquires a new lock after stale lock reclamation', async () => {
            lockStub.restore();
            const environment = await createOwnedEnvironment();
            const lockPath = lockfileApis.getFileLockPath(environment.sysPrefix);
            const quarantinedLockPath = `${lockPath}.reclaimed-for-test`;
            await fs.ensureDir(lockPath);
            await fs.writeFile(path.join(lockPath, 'owner-424242-dead'), '');
            sinon.stub(lockfileApis, 'inspectFileLock').onFirstCall().resolves('stale').onSecondCall().resolves('held');
            sinon.stub(lockfileApis, 'reclaimFileLock').callsFake(async () => {
                await fs.rename(lockPath, quarantinedLockPath);
                await fs.ensureDir(lockPath);
                await fs.writeFile(path.join(lockPath, `owner-${process.pid}-live`), '');
                return true;
            });

            await assert.rejects(manager.clearCache(), /being created/);

            assert.strictEqual(await fs.pathExists(environment.sysPrefix), true);
            assert.strictEqual(await fs.pathExists(lockPath), true);
        });

        test('holds the entry lock through deletion', async () => {
            lockStub.restore();
            const environment = await createOwnedEnvironment();
            const lockPath = lockfileApis.getFileLockPath(environment.sysPrefix);
            const internalManager = manager as unknown as {
                deleteCacheEntryForClear(entryPath: string): Promise<void>;
            };
            const removeStub = sinon.stub(internalManager, 'deleteCacheEntryForClear').callThrough();
            removeStub.callsFake(async (target) => {
                if (normalizePath(target) === normalizePath(environment.sysPrefix)) {
                    assert.strictEqual(await fs.pathExists(lockPath), true, 'entry lock must protect deletion');
                }
                await fs.remove(target);
            });

            await manager.clearCache();

            sinon.assert.calledWith(removeStub, environment.sysPrefix);
            assert.strictEqual(await fs.pathExists(environment.sysPrefix), false);
        });

        test('rejects an orphaned lock directory conservatively', async () => {
            lockStub.restore();
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            await fs.ensureDir(lockfileApis.getFileLockPath(environment.sysPrefix));

            await assert.rejects(manager.clearCache(), /incomplete or malformed/);

            assert.strictEqual(await fs.pathExists(environment.sysPrefix), true);
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('surfaces a persistence failure after clearing disk and memory state', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            workspaceState.clear.onFirstCall().rejects(new Error('Memento unavailable'));

            await assert.rejects(manager.clearCache(), /Memento unavailable/);

            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(listener.callCount, 1);
            assert.strictEqual(normalizePath(listener.firstCall.args[0].uri.fsPath), normalizePath(uri.fsPath));
            assert.strictEqual(listener.firstCall.args[0].old, environment);
            assert.strictEqual(listener.firstCall.args[0].new, undefined);
        });

        test('preserves associations and emits events only for entries removed before a partial failure', async () => {
            const firstUri = scriptUri('first.py');
            const secondUri = scriptUri('second.py');
            const firstEnvironment = await createOwnedEnvironment();
            const secondEnvironment = await createOwnedEnvironment('fedcba9876543210');
            await manager.set(firstUri, firstEnvironment);
            await manager.set(secondUri, secondEnvironment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            const internalManager = manager as unknown as {
                deleteCacheEntryForClear(entryPath: string): Promise<void>;
            };
            sinon.stub(internalManager, 'deleteCacheEntryForClear').callsFake(async (target) => {
                if (normalizePath(target) === normalizePath(secondEnvironment.sysPrefix)) {
                    throw new Error('second entry is busy');
                }
                await fs.remove(target);
            });

            await assert.rejects(manager.clearCache(), /Failed to completely clear/);

            assert.strictEqual(await fs.pathExists(firstEnvironment.sysPrefix), false);
            assert.strictEqual(await fs.pathExists(secondEnvironment.sysPrefix), true);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(secondUri.fsPath)]: secondEnvironment.environmentPath.fsPath,
            });
            assert.strictEqual(await manager.get(firstUri), undefined);
            assert.strictEqual(await manager.get(secondUri), secondEnvironment);
            sinon.assert.calledOnce(listener);
            assert.strictEqual(normalizePath(listener.firstCall.args[0].uri.fsPath), normalizePath(firstUri.fsPath));
            assert.strictEqual(listener.firstCall.args[0].old, firstEnvironment);
            assert.strictEqual(listener.firstCall.args[0].new, undefined);
        });

        test('stops before deletion when the physical cache root changes', async () => {
            const environment = await createOwnedEnvironment();
            const otherPhysicalRoot = path.join(tempRoot, 'other-cache-root');
            await fs.ensureDir(otherPhysicalRoot);
            const internalManager = manager as unknown as {
                getPhysicalOwnedCacheRootPath(cacheRoot: Uri): Promise<string | undefined>;
            };
            const rootStub = sinon.stub(internalManager, 'getPhysicalOwnedCacheRootPath').callThrough();
            rootStub.onSecondCall().resolves(otherPhysicalRoot);

            await assert.rejects(manager.clearCache(), /physical root changed/);

            assert.strictEqual(await fs.pathExists(environment.sysPrefix), true);
        });

        test('does not let a pending rehydration restore an association after clear cache', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            let resolveRehydration: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveRehydration = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);
            await manager.clearCache();
            resolveRehydration!(environment);

            assert.strictEqual(await pendingGet, undefined);
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(listener.callCount, 0);
        });

        test('rejects clear when creation started before the clear request', async () => {
            const uri = scriptUri();
            let resolveMetadata: ((value: metadataReader.InlineScriptMetadata | undefined) => void) | undefined;
            readMetadataStub.callsFake(
                () =>
                    new Promise<metadataReader.InlineScriptMetadata | undefined>((resolve) => {
                        resolveMetadata = resolve;
                    }),
            );

            const createPromise = manager.create(uri);

            await assert.rejects(manager.clearCache(), /being created/);
            resolveMetadata!(VALID_METADATA);
            assert.ok(await createPromise);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), true);
        });

        test('queues create behind a clear request that started first', async () => {
            const uri = scriptUri();
            let releaseClear: (() => void) | undefined;
            let signalClearStarted: (() => void) | undefined;
            const clearStarted = new Promise<void>((resolve) => {
                signalClearStarted = resolve;
            });
            workspaceState.clear.callsFake(
                async (keys?: string[]) =>
                    new Promise<void>((resolve) => {
                        signalClearStarted!();
                        releaseClear = () => {
                            if (!keys || keys.includes(INLINE_SCRIPT_ENVS_KEY)) {
                                persistedAssociations = undefined;
                            }
                            resolve();
                        };
                    }),
            );

            const clearPromise = manager.clearCache();
            const createPromise = manager.create(uri);

            await clearStarted;
            assert.strictEqual(readMetadataStub.callCount, 0);
            releaseClear!();
            await clearPromise;

            assert.ok(await createPromise);
            assert.ok(readMetadataStub.calledOnce);
        });
    });
});
