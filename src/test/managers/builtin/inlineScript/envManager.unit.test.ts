// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../../api';
import * as cacheKey from '../../../../common/inlineScript/cacheKey';
import * as cacheLayout from '../../../../common/inlineScript/cacheLayout';
import * as metadataReader from '../../../../common/inlineScript/metadata';
import * as lockfileApis from '../../../../common/lockfile.apis';
import { isWindows } from '../../../../common/utils/platformUtils';
import { getVenvPythonPath } from '../../../../common/utils/virtualEnvironment';
import { InlineScriptEnvManager } from '../../../../managers/builtin/inlineScript/envManager';
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
    let createWithProgressStub: sinon.SinonStub;
    let getAvailablePythonVersionsStub: sinon.SinonStub;
    let ensureUvForVersionLookupStub: sinon.SinonStub;
    let globalStorageUri: Uri;
    let lockStub: sinon.SinonStub;
    let manager: InlineScriptEnvManager;
    let nativeFinder: NativePythonFinder;
    let promptInstallPythonViaUvStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let inspectMetaStub: sinon.SinonStub;
    let retainLockStub: sinon.SinonStub;
    let releaseLockStub: sinon.SinonStub;
    let resolveSystemPythonStub: sinon.SinonStub;
    let resolveVenvStub: sinon.SinonStub;
    let tempRoot: string;
    let baseInterpreterStatusStub: sinon.SinonStub;
    let writeMetaStub: sinon.SinonStub;

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

        readMetadataStub = sinon.stub(metadataReader, 'readInlineScriptMetadataFromFile').resolves(VALID_METADATA);
        computeCacheKeyStub = sinon.stub(cacheKey, 'computeCacheKey').returns(CACHE_KEY);
        getAvailablePythonVersionsStub = sinon.stub(uvPythonInstaller, 'getAvailablePythonVersions').resolves([]);
        ensureUvForVersionLookupStub = sinon
            .stub(uvPythonInstaller, 'ensureUvForInlineScriptVersionLookup')
            .resolves(true);
        promptInstallPythonViaUvStub = sinon.stub(uvPythonInstaller, 'promptInstallPythonViaUv');
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

        sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(undefined);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);
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
            promptInstallPythonViaUvStub.resolves(uvExecutable);
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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
                promptInstallPythonViaUvStub.resolves(baseExecutable);

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
                return uvExecutable;
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
                return uvExecutable;
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
                return uvExecutable;
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
            promptInstallPythonViaUvStub.resolves(uvExecutable);

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
});
