// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, Memento, Uri } from 'vscode';
import { EnvironmentManager, PackageManager, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import {
    CapabilityContext,
    EnvironmentCapability,
    PackageCapability,
    resolveEnvironmentManagerCapability as environmentCapability,
    resolvePackageManagerCapability as packageCapability,
    Support,
} from '../../capabilities';
import * as childProcessApis from '../../common/childProcess.apis';
import * as metadata from '../../common/inlineScript/metadata';
import * as platformUtils from '../../common/utils/platformUtils';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import * as helpers from '../../managers/builtin/helpers';
import { InlineScriptEnvManager } from '../../managers/builtin/inlineScript/envManager';
import { PipPackageManager } from '../../managers/builtin/pipPackageManager';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import { VenvManager } from '../../managers/builtin/venvManager';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../managers/conda/condaEnvManager';
import { CondaPackageManager } from '../../managers/conda/condaPackageManager';
import * as condaUtils from '../../managers/conda/condaUtils';
import { PipenvManager } from '../../managers/pipenv/pipenvManager';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../managers/poetry/poetryPackageManager';
import { PyEnvManager } from '../../managers/pyenv/pyenvManager';
import { createMockLogOutputChannel } from '../mocks/helper';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

suite('Built-in manager capabilities', () => {
    const root = path.join(process.cwd(), 'capability-fixtures');
    const project: PythonProject = { name: 'project', uri: Uri.file(path.join(root, 'project')) };
    const otherProject: PythonProject = { name: 'other', uri: Uri.file(path.join(root, 'other')) };
    let api: PythonEnvironmentApi;
    let log: ReturnType<typeof createMockLogOutputChannel>;
    let prompt: sinon.SinonStub;
    let spawn: sinon.SinonStub;
    const disposables: Disposable[] = [];

    function environment(version = '3.12.0'): PythonEnvironment {
        return createMockPythonEnvironment({ envPath: path.join(root, '.venv'), version });
    }

    function venv(): VenvManager {
        return new VenvManager({} as NativePythonFinder, api, {} as EnvironmentManager, log);
    }

    function pip(): PipPackageManager {
        const manager = new PipPackageManager(api, log, venv());
        disposables.push(manager);
        return manager;
    }

    function poetry(): PoetryPackageManager {
        const manager = new PoetryPackageManager(api, log, {} as PoetryManager);
        disposables.push(manager);
        return manager;
    }

    function assertUnsupported(result: Support): void {
        assert.strictEqual(result.supported, false);
        if (!result.supported) {
            assert.ok(result.reason.length > 0);
        }
    }

    setup(() => {
        api = {
            getPythonProject: sinon.stub().returns(project),
            getPythonProjects: sinon.stub().returns([project]),
            getEnvironments: sinon.stub().rejects(new Error('Unexpected environment discovery')),
        } as unknown as PythonEnvironmentApi;
        log = createMockLogOutputChannel();
        prompt = sinon.stub(windowApis, 'showErrorMessage').rejects(new Error('Unexpected prompt'));
        sinon.stub(windowApis, 'showQuickPick').rejects(new Error('Unexpected picker'));
        spawn = sinon.stub(childProcessApis, 'spawnProcess').throws(new Error('Unexpected process'));
    });

    teardown(() => {
        for (const disposable of disposables.splice(0)) {
            disposable.dispose();
        }
        assert.ok(prompt.notCalled);
        assert.ok(spawn.notCalled);
        sinon.restore();
    });

    for (const version of [undefined, '2.7.18', 'invalid', '3.12.0']) {
        test(`venv quick creation requires global Python 3: ${version}`, async () => {
            const manager = venv();
            (manager as unknown as { globalEnv?: PythonEnvironment }).globalEnv = version
                ? environment(version)
                : undefined;
            const create = sinon.stub(manager, 'create').rejects(new Error('Unexpected creation'));
            const check = manager.capabilities['environments.create.quick']!;
            assert.strictEqual((await check({ scope: 'global' })).supported, version === '3.12.0');
            // General support is independent of the quick-path prerequisite; only quick mode forwards packages.
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.additionalPackages'), {
                supported: true,
            });
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.remove.headless'), {
                supported: true,
            });
            assert.ok(create.notCalled);
        });
    }

    test('venv quick and additional packages preserve explicit create opt-outs', async () => {
        const manager = venv();
        const denied: Support = { supported: false, reason: 'Disabled by provider' };
        sinon.stub(manager, 'capabilities').value({
            ...manager.capabilities,
            'environments.create': async () => denied,
        });
        for (const key of ['environments.create.quick', 'environments.create.additionalPackages'] as const) {
            assert.strictEqual(await environmentCapability(manager, key), denied);
        }
    });

    test('system Python rejects ignored creation options without invoking installation', async () => {
        const manager = new SysPythonManager({} as NativePythonFinder, api, log);
        const create = sinon.stub(manager, 'create');
        assert.deepStrictEqual(await environmentCapability(manager, 'environments.create'), { supported: true });
        for (const key of ['environments.create.quick', 'environments.create.additionalPackages', 'environments.remove'] as const) {
            assertUnsupported(await environmentCapability(manager, key));
        }
        assert.ok(create.notCalled);
    });

    test('Conda local quick creation needs a project, not a base Python or an operation probe', async () => {
        const manager = new CondaEnvManager({} as NativePythonFinder, api, log);
        disposables.push(manager);
        const create = sinon.stub(manager, 'create');
        const remove = sinon.stub(manager, 'remove');
        assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.quick', { scope: project.uri }), {
            supported: true,
        });
        (api.getPythonProject as sinon.SinonStub).returns(undefined);
        assertUnsupported(await environmentCapability(manager, 'environments.create.quick', { scope: project.uri }));
        for (const scope of [undefined, 'all', []] as CapabilityContext['scope'][]) {
            assertUnsupported(await environmentCapability(manager, 'environments.create.quick', { scope }));
        }
        assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.additionalPackages'), { supported: true });
        assert.deepStrictEqual(await environmentCapability(manager, 'environments.remove.headless'), { supported: true });
        assert.ok(create.notCalled && remove.notCalled);
    });

    test('Conda global and multi-root quick support does not preflight creation or discover tool state', async () => {
        const manager = new CondaEnvManager({} as NativePythonFinder, api, log);
        disposables.push(manager);
        const prefix = sinon.stub(condaUtils, 'getDefaultCondaPrefix').rejects(new Error('Unexpected prefix probe'));
        const name = sinon.stub(condaUtils, 'generateName').rejects(new Error('Unexpected name probe'));
        const discovery = sinon.stub(condaUtils, 'getConda').rejects(new Error('Unexpected tool discovery'));
        const create = sinon.stub(condaUtils, 'quickCreateConda');
        for (const scope of ['global', [project.uri, otherProject.uri]] as CapabilityContext['scope'][]) {
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.quick', { scope }), { supported: true });
        }
        assert.ok(prefix.notCalled && name.notCalled && discovery.notCalled && create.notCalled);
    });

    suite('inline scripts', () => {
        let manager: InlineScriptEnvManager;
        let readMetadata: sinon.SinonStub;
        let stateUpdate: sinon.SinonStub;
        const script = Uri.file(path.join(root, 'script.py'));

        setup(() => {
            sinon.stub(workspaceApis, 'onDidDeleteFiles').returns(new Disposable(() => undefined));
            sinon.stub(workspaceApis, 'onDidRenameFiles').returns(new Disposable(() => undefined));
            stateUpdate = sinon.stub().resolves();
            manager = new InlineScriptEnvManager(
                {} as NativePythonFinder, api, {} as EnvironmentManager, Uri.file(path.join(root, 'storage')), log,
                { get: sinon.stub().returns(undefined), update: stateUpdate, keys: () => [] } as Memento,
            );
            disposables.push(manager);
            readMetadata = sinon.stub(metadata, 'readInlineScriptMetadataFromFile').resolves({
                requiresPython: '>=3.11', dependencies: ['requests'], range: { start: 0, end: 40 },
            });
        });

        test('inline URI resolution is unsupported without invoking its stub', async () => {
            const resolve = sinon.stub(manager, 'resolve');
            assertUnsupported(await environmentCapability(manager, 'environments.resolve', { scope: script }));
            assert.ok(resolve.notCalled && stateUpdate.notCalled && readMetadata.notCalled);
        });

        test('valid local script supports quick creation without quickCreateConfig or mutations', async () => {
            const create = sinon.stub(manager, 'create');
            const remove = sinon.stub(manager, 'remove');
            const select = sinon.stub(manager, 'set');
            assert.strictEqual((manager as EnvironmentManager).quickCreateConfig, undefined);
            for (const scope of [script, [script]]) {
                for (const key of ['environments.create', 'environments.create.quick', 'environments.create.additionalPackages'] as const) {
                    assert.deepStrictEqual(await environmentCapability(manager, key, { scope }), { supported: true });
                }
            }
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.remove.headless'), { supported: true });
            assert.ok(create.notCalled && remove.notCalled && select.notCalled && stateUpdate.notCalled);
            assert.ok((api.getEnvironments as sinon.SinonStub).notCalled);
            assert.ok(readMetadata.alwaysCalledWithExactly(script, { strict: true }));
        });

        test('invalid scopes and invalid metadata disable all creation variants', async () => {
            const scopes: CapabilityContext['scope'][] = [undefined, 'global', 'all', [], [script, script], Uri.parse('untitled:script.py')];
            const keys: EnvironmentCapability[] = ['environments.create', 'environments.create.quick', 'environments.create.additionalPackages'];
            for (const scope of scopes) {
                for (const key of keys) {
                    assertUnsupported(await environmentCapability(manager, key, { scope }));
                }
            }
            assert.ok(readMetadata.notCalled);
            readMetadata.resolves(undefined);
            for (const key of keys) {
                assertUnsupported(await environmentCapability(manager, key, { scope: script }));
            }
            readMetadata.rejects(new Error('Metadata probe failed'));
            await assert.rejects(environmentCapability(manager, 'environments.create.quick', { scope: script }), /Metadata probe failed/);
            assert.ok(stateUpdate.notCalled);
        });

        for (const code of ['EACCES', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR']) {
            test(`real metadata reader handles ${code} during capability queries`, async () => {
                readMetadata.restore();
                const error = Object.assign(new Error(`File open failed: ${code}`), { code });
                const open = sinon.stub(fs, 'open').rejects(error);
                for (const key of ['environments.create', 'environments.create.quick', 'environments.create.additionalPackages'] as const) {
                    const result = environmentCapability(manager, key, { scope: script });
                    if (code === 'EACCES' || code === 'EIO') {
                        await assert.rejects(result, (failure) => failure === error);
                    } else {
                        assertUnsupported(await result);
                    }
                }
                assert.strictEqual(open.callCount, 3);
                assert.ok(open.alwaysCalledWithExactly(script.fsPath, 'r'));
                assert.ok(stateUpdate.notCalled);
            });
        }
    });

    for (const [version, supported] of [['21.1.3', false], ['21.2', true], ['21.2.0', true], ['25.0', true], ['25.1', true], ['26.0', true]] as const) {
        test(`pip ${version} version lookup support is ${supported} without querying an index`, async () => {
            const manager = pip();
            sinon.stub(helpers, 'shouldUseUv').resolves(false);
            const runPython = sinon.stub(helpers, 'runPython').resolves(`pip ${version} from pip (python 3.12)`);
            const lookup = sinon.stub(manager, 'getPackageAvailableVersions');
            assert.strictEqual((await packageCapability(manager, 'packages.availableVersions', { environment: environment() })).supported, supported);
            assert.strictEqual(runPython.callCount, 1);
            assert.deepStrictEqual(runPython.firstCall.args[1], ['-m', 'pip', '--version']);
            assert.ok(lookup.notCalled);
        });
    }

    test('uv backend bypasses pip version checks and never runs uv tool or index commands', async () => {
        const manager = pip();
        const env = environment();
        const useUv = sinon.stub(helpers, 'shouldUseUv').resolves(true);
        const uvExecutable = sinon.stub(helpers, 'getUvExecutable').resolves('uv');
        const runPython = sinon.stub(helpers, 'runPython');
        const runUv = sinon.stub(helpers, 'runUV');
        assert.deepStrictEqual(await packageCapability(manager, 'packages.availableVersions', { environment: env }), { supported: true });
        assert.ok(useUv.calledOnceWithExactly(log, env.environmentPath.fsPath));
        assert.ok(uvExecutable.calledOnceWithExactly(log, env.environmentPath.fsPath));
        assert.ok(runPython.notCalled && runUv.notCalled);
        uvExecutable.resolves(undefined);
        await assert.rejects(packageCapability(manager, 'packages.availableVersions', { environment: env }), /uv became unavailable/);
    });

    test('pip reports missing context and unknown versions but propagates unexpected probe failures', async () => {
        const manager = pip();
        const useUv = sinon.stub(helpers, 'shouldUseUv').resolves(false);
        const runPython = sinon.stub(helpers, 'runPython').resolves('unknown');
        const missingExecutable = { ...environment(), execInfo: { run: { executable: '' } } };
        for (const env of [undefined, missingExecutable, environment('invalid')]) {
            assertUnsupported(await packageCapability(manager, 'packages.availableVersions', { environment: env }));
        }
        assert.ok(useUv.notCalled && runPython.notCalled);
        assertUnsupported(await packageCapability(manager, 'packages.availableVersions', { environment: environment() }));
        const failure = new Error('Python probe failed');
        runPython.rejects(failure);
        await assert.rejects(packageCapability(manager, 'packages.availableVersions', { environment: environment() }), (error) => error === failure);
    });

    test('pip direct names remain best-effort and command-only inline restrictions are not capabilities', async () => {
        const manager = pip();
        const env = createMockPythonEnvironment({ envPath: path.join(root, 'inline'), managerId: 'ms-python.python:inline-script' });
        const direct = sinon.stub(manager, 'getDirectPackageNames');
        const manage = sinon.stub(manager, 'manage');
        for (const key of ['packages.direct', 'packages.manage', 'packages.manage.headless', 'packages.manage.upgrade', 'packages.manage.showSkipOption', 'packages.list.skipCache'] as const) {
            assert.deepStrictEqual(await packageCapability(manager, key, { environment: env }), { supported: true });
        }
        assertUnsupported(await packageCapability(manager, 'packages.direct'));
        assert.ok(direct.notCalled && manage.notCalled);
    });

    test('Poetry closures require their own bound project and reject another project identity', async () => {
        const manager = poetry();
        const first = manager.createForProject(project);
        const second = manager.createForProject(otherProject);
        disposables.push(first, second);
        const keys: PackageCapability[] = ['packages.list', 'packages.list.skipCache', 'packages.direct', 'packages.manage', 'packages.manage.headless', 'packages.refresh'];
        for (const key of keys) {
            assertUnsupported(await packageCapability(manager, key, { project }));
            assert.deepStrictEqual(await packageCapability(first, key, { project }), { supported: true });
            assertUnsupported(await packageCapability(first, key, { project: otherProject }));
            assert.deepStrictEqual(await packageCapability(second, key, { project: otherProject }), { supported: true });
        }
        const extracted = first.capabilities['packages.list']!;
        assert.deepStrictEqual(await extracted({ project: { ...project, uri: Uri.parse(project.uri.toString()) } }), { supported: true });
        assert.deepStrictEqual(await extracted({}), { supported: true });
        assertUnsupported(await extracted({ project: otherProject }));
    });

    test('Poetry ignores neither unsupported options nor its throwing lookup hook during capability checks', async () => {
        const manager = poetry().createForProject(project);
        disposables.push(manager);
        const lookup = sinon.stub(manager, 'getPackageAvailableVersions');
        const manage = sinon.stub(manager, 'manage');
        for (const key of ['packages.availableVersions', 'packages.manage.upgrade', 'packages.manage.showSkipOption'] as const) {
            assertUnsupported(await packageCapability(manager, key, { project }));
        }
        assert.deepStrictEqual(await packageCapability(manager, 'packages.formatInstallSpec'), { supported: true });
        assert.ok(lookup.notCalled && manage.notCalled);
    });

    for (const windows of [true, false]) {
        test(`Poetry project identities respect ${windows ? 'Windows' : 'POSIX'} path casing`, async () => {
            sinon.stub(platformUtils, 'isWindows').returns(windows);
            const mixedCase = { ...project, uri: Uri.file(path.join(root, 'MixedCaseProject')) };
            const manager = poetry().createForProject(mixedCase);
            disposables.push(manager);
            const otherCase = { ...mixedCase, uri: Uri.file(path.join(root, 'mixedcaseproject')) };
            assert.strictEqual((await packageCapability(manager, 'packages.list', { project: otherCase })).supported, windows);
            const equivalent = {
                ...mixedCase,
                uri: Uri.file(path.join(mixedCase.uri.fsPath, 'child', '..')),
            };
            assert.deepStrictEqual(await packageCapability(manager, 'packages.list', { project: equivalent }), { supported: true });
            for (const uri of [
                otherProject.uri,
                mixedCase.uri.with({ scheme: 'vscode-remote' }),
                mixedCase.uri.with({ authority: 'different-host' }),
                mixedCase.uri.with({ query: 'revision=1' }),
                mixedCase.uri.with({ fragment: 'different' }),
            ]) {
                assertUnsupported(await packageCapability(manager, 'packages.list', { project: { ...project, uri } }));
            }
        });
    }

    test('Poetry non-file project identities preserve URI casing, scheme and authority', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        const remote = { ...project, uri: project.uri.with({ scheme: 'vscode-remote', authority: 'host', path: '/Project' }) };
        const manager = poetry().createForProject(remote);
        disposables.push(manager);
        assert.deepStrictEqual(await packageCapability(manager, 'packages.list', { project: remote }), { supported: true });
        for (const uri of [
            remote.uri.with({ path: '/project' }),
            remote.uri.with({ authority: 'other-host' }),
            remote.uri.with({ scheme: 'other' }),
        ]) {
            assertUnsupported(await packageCapability(manager, 'packages.list', { project: { ...remote, uri } }));
        }
    });

    test('Conda package advertisements preserve absent direct names and implemented lookup/watch hooks', async () => {
        const manager = new CondaPackageManager(api, log);
        disposables.push(manager);
        const lookup = sinon.stub(manager, 'getPackageAvailableVersions');
        const watch = sinon.stub(manager, 'getPackageWatchTargets');
        assertUnsupported(await packageCapability(manager, 'packages.direct'));
        for (const key of ['packages.availableVersions', 'packages.formatInstallSpec', 'packages.watchTargets'] as const) {
            assert.deepStrictEqual(await packageCapability(manager, key, { environment: environment() }), { supported: true });
        }
        assert.ok(lookup.notCalled && watch.notCalled);
    });

    suite('exhaustive optional advertisements', () => {
        const environmentKeys: EnvironmentCapability[] = [
            'environments.create', 'environments.create.quick', 'environments.create.additionalPackages',
            'environments.remove', 'environments.remove.headless', 'environments.clearCache',
            'environments.events.changed', 'environments.events.selectionChanged',
        ];
        const commonEnvironmentKeys: EnvironmentCapability[] = [
            'environments.clearCache', 'environments.events.changed', 'environments.events.selectionChanged',
        ];
        const environmentManagers: {
            name: string;
            create: () => EnvironmentManager;
            supported: EnvironmentCapability[];
        }[] = [
            {
                name: 'venv',
                create: () => {
                    const manager = venv();
                    (manager as unknown as { globalEnv: PythonEnvironment }).globalEnv = environment();
                    return manager;
                },
                supported: environmentKeys,
            },
            {
                name: 'system',
                create: () => new SysPythonManager({} as NativePythonFinder, api, log),
                supported: [...commonEnvironmentKeys, 'environments.create'],
            },
            {
                name: 'inline-script',
                create: () => {
                    sinon.stub(workspaceApis, 'onDidDeleteFiles').returns(new Disposable(() => undefined));
                    sinon.stub(workspaceApis, 'onDidRenameFiles').returns(new Disposable(() => undefined));
                    sinon.stub(metadata, 'readInlineScriptMetadataFromFile').resolves({ range: { start: 0, end: 20 } });
                    const manager = new InlineScriptEnvManager(
                        {} as NativePythonFinder, api, {} as EnvironmentManager, Uri.file(path.join(root, 'storage')), log,
                        { get: sinon.stub().returns(undefined), update: sinon.stub().resolves(), keys: () => [] } as Memento,
                    );
                    disposables.push(manager);
                    return manager;
                },
                supported: environmentKeys,
            },
            {
                name: 'conda',
                create: () => {
                    const manager = new CondaEnvManager({} as NativePythonFinder, api, log);
                    disposables.push(manager);
                    return manager;
                },
                supported: environmentKeys,
            },
            ...[
                { name: 'poetry', constructor: PoetryManager },
                { name: 'pipenv', constructor: PipenvManager },
                { name: 'pyenv', constructor: PyEnvManager },
            ].map(({ name, constructor }) => ({
                name,
                create: () => {
                    const manager = new constructor({} as NativePythonFinder, api);
                    disposables.push(manager);
                    return manager;
                },
                supported: commonEnvironmentKeys,
            })),
        ];

        for (const row of environmentManagers) {
            test(`${row.name} advertises every supported optional environment hook`, async () => {
                const manager = row.create();
                const context: CapabilityContext = { scope: project.uri, project, environment: environment() };
                for (const key of environmentKeys) {
                    const result = await environmentCapability(manager, key, context);
                    assert.strictEqual(result.supported, row.supported.includes(key), key);
                    if (!result.supported) {
                        assertUnsupported(result);
                    }
                    if (row.supported.includes(key) && !['environments.create.additionalPackages', 'environments.remove.headless'].includes(key)) {
                        assert.ok(Object.prototype.hasOwnProperty.call(manager.capabilities, key), `Missing explicit ${key}`);
                        const check = manager.capabilities![key]!;
                        assert.deepStrictEqual(await check(context), { supported: true }, `Unbound ${key}`);
                    }
                    const denied: Support = { supported: false, reason: 'Provider disabled this feature' };
                    const advertisement = sinon.stub(manager, 'capabilities').value({ ...manager.capabilities, [key]: async () => denied });
                    assert.strictEqual(await environmentCapability(manager, key, context), denied, `Opt-out ${key}`);
                    advertisement.restore();
                }
            });
        }

        const packageKeys: PackageCapability[] = [
            'packages.direct', 'packages.version', 'packages.availableVersions', 'packages.formatInstallSpec',
            'packages.clearCache', 'packages.watchTargets', 'packages.events.changed',
        ];
        const packageManagers: {
            name: string;
            create: () => PackageManager;
            supported: PackageCapability[];
        }[] = [
            {
                name: 'pip',
                create: () => {
                    sinon.stub(helpers, 'shouldUseUv').resolves(false);
                    sinon.stub(helpers, 'runPython').resolves('pip 25.1 from pip (python 3.12)');
                    return pip();
                },
                supported: ['packages.direct', 'packages.version', 'packages.availableVersions', 'packages.formatInstallSpec', 'packages.events.changed'],
            },
            {
                name: 'conda',
                create: () => {
                    const manager = new CondaPackageManager(api, log);
                    disposables.push(manager);
                    return manager;
                },
                supported: ['packages.version', 'packages.availableVersions', 'packages.formatInstallSpec', 'packages.watchTargets', 'packages.events.changed'],
            },
            {
                name: 'poetry',
                create: () => {
                    const manager = poetry().createForProject(project);
                    disposables.push(manager);
                    return manager;
                },
                supported: ['packages.direct', 'packages.version', 'packages.formatInstallSpec', 'packages.events.changed'],
            },
        ];

        for (const row of packageManagers) {
            test(`${row.name} advertises every supported optional package hook`, async () => {
                const manager = row.create();
                const context: CapabilityContext = { scope: project.uri, project, environment: environment() };
                for (const key of packageKeys) {
                    const result = await packageCapability(manager, key, context);
                    assert.strictEqual(result.supported, row.supported.includes(key), key);
                    if (!result.supported) {
                        assertUnsupported(result);
                    }
                    if (row.supported.includes(key) && key !== 'packages.formatInstallSpec') {
                        assert.ok(Object.prototype.hasOwnProperty.call(manager.capabilities, key), `Missing explicit ${key}`);
                        const check = manager.capabilities![key]!;
                        assert.deepStrictEqual(await check(context), { supported: true }, `Unbound ${key}`);
                    }
                    const denied: Support = { supported: false, reason: 'Provider disabled this feature' };
                    const advertisement = sinon.stub(manager, 'capabilities').value({ ...manager.capabilities, [key]: async () => denied });
                    assert.strictEqual(await packageCapability(manager, key, context), denied, `Opt-out ${key}`);
                    advertisement.restore();
                }
            });
        }
    });
});
