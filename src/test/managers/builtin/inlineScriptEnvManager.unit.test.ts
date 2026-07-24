// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as cacheKey from '../../../common/inlineScriptCacheKey';
import * as cacheLayout from '../../../common/inlineScriptCacheLayout';
import * as lockfileApis from '../../../common/lockfile.apis';
import * as metadataReader from '../../../common/inlineScriptMetadata';
import { isWindows } from '../../../common/utils/platformUtils';
import * as persistentState from '../../../common/persistentState';
import { normalizePath } from '../../../common/utils/pathUtils';
import { getVenvPythonPath } from '../../../common/utils/virtualEnvironment';
import {
    InlineScriptEnvManager,
    INLINE_SCRIPT_ENVS_KEY,
} from '../../../managers/builtin/inlineScriptEnvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

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

const venvPythonPath = getVenvPythonPath;

suite('InlineScriptEnvManager', () => {
    let api: PythonEnvironmentApi;
    let apiGetEnvironmentsStub: sinon.SinonStub;
    let baseEnvironment: PythonEnvironment;
    let baseExecutable: string;
    let baseManager: EnvironmentManager;
    let computeCacheKeyStub: sinon.SinonStub;
    let createWithProgressStub: sinon.SinonStub;
    let globalStorageUri: Uri;
    let lockStub: sinon.SinonStub;
    let manager: InlineScriptEnvManager;
    let nativeFinder: NativePythonFinder;
    let readMetadataStub: sinon.SinonStub;
    let inspectMetaStub: sinon.SinonStub;
    let retainLockStub: sinon.SinonStub;
    let releaseLockStub: sinon.SinonStub;
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
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-script-manager-'));
        globalStorageUri = Uri.file(path.join(tempRoot, 'global-storage'));
        baseExecutable = path.join(tempRoot, 'base-python', isWindows() ? 'python.exe' : 'python');
        await fs.outputFile(baseExecutable, '');
        baseEnvironment = makeEnvironment('ms-python.python:system', '3.12.4', baseExecutable);

        apiGetEnvironmentsStub = sinon.stub().resolves([baseEnvironment]);
        api = { getEnvironments: apiGetEnvironmentsStub } as unknown as PythonEnvironmentApi;
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
            clear: sinon.stub(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(workspaceState);

        readMetadataStub = sinon.stub(metadataReader, 'readInlineScriptMetadataFromFile').resolves(VALID_METADATA);
        computeCacheKeyStub = sinon.stub(cacheKey, 'computeCacheKey').returns(CACHE_KEY);
        inspectMetaStub = sinon.stub(cacheLayout, 'inspectMetaJson').resolves({ kind: 'missing' });
        baseInterpreterStatusStub = sinon.stub(cacheLayout, 'getBaseInterpreterStatus').resolves('available');
        writeMetaStub = sinon.stub(cacheLayout, 'writeMetaJson').resolves();
        retainLockStub = sinon.stub().resolves();
        releaseLockStub = sinon.stub().resolves();
        lockStub = sinon
            .stub(lockfileApis, 'acquireFileLock')
            .resolves({ release: releaseLockStub, retain: retainLockStub });
        resolveVenvStub = sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);
        createWithProgressStub = sinon.stub(venvUtils, 'createWithProgress').callsFake(async (...args: unknown[]) => {
            const envDir = args[6] as string;
            await fs.outputFile(getVenvPythonPath(envDir), '');
            return {
                environment: makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.12.4',
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
            assert.deepStrictEqual(createWithProgressStub.firstCall.args[8], { trackUvEnvironment: false });
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
            assert.strictEqual(listener.callCount, 0);
        });

        test('ignores invalid scopes and never writes venv workspace state', async () => {
            const environment = await createOwnedEnvironment();

            await manager.set(undefined, environment);
            await manager.set(Uri.parse('untitled:script.py'), environment);
            await manager.set([Uri.parse('untitled:script.py')], environment);

            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(await manager.get(undefined), undefined);
            assert.strictEqual(await manager.get(Uri.parse('untitled:script.py')), undefined);
        });
    });
});
