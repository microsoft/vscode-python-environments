// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, Memento, Uri } from 'vscode';
import { EnvironmentManager, PackageManager, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import {
    CapabilityContext,
    EnvironmentManagerCapability,
    PackageManagerCapability,
    resolveEnvironmentManagerCapability as environmentCapability,
    resolvePackageManagerCapability as packageCapability,
    Support,
} from '../../capabilities';
import * as childProcessApis from '../../common/childProcess.apis';
import * as metadata from '../../common/inlineScript/metadata';
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

    function environment(): PythonEnvironment {
        return createMockPythonEnvironment({ envPath: path.join(root, '.venv') });
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

    for (const [name, createManager] of [
        ['venv', venv],
        ['Conda', () => {
            const manager = new CondaEnvManager({} as NativePythonFinder, api, log);
            disposables.push(manager);
            return manager;
        }],
    ] as const) {
        test(`${name} quick support inherits create without preflighting runtime prerequisites`, async () => {
            const manager = createManager();
            const create = sinon.stub(manager, 'create').rejects(new Error('Unexpected creation'));
            (api.getPythonProject as sinon.SinonStub).returns(undefined);
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.quick'), { supported: true });
            const denied: Support = { supported: false, reason: 'Disabled by provider' };
            sinon.stub(manager, 'capabilities').value({
                ...manager.capabilities,
                'environments.create': async () => denied,
            });
            assert.strictEqual(await environmentCapability(manager, 'environments.create.quick'), denied);
            assert.ok(create.notCalled);
            assert.ok((api.getPythonProject as sinon.SinonStub).notCalled);
        });
    }

    test('system Python rejects ignored creation options without invoking installation', async () => {
        const manager = new SysPythonManager({} as NativePythonFinder, api, log);
        const create = sinon.stub(manager, 'create');
        assert.deepStrictEqual(await environmentCapability(manager, 'environments.create'), { supported: true });
        for (const key of ['environments.create.quick', 'environments.create.additionalPackages', 'environments.remove'] as const) {
            assertUnsupported(await environmentCapability(manager, key));
        }
        assert.ok(create.notCalled);
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
            assert.ok(readMetadata.alwaysCalledWithExactly(script));
        });

        test('invalid scopes and invalid metadata disable all creation variants', async () => {
            const scopes: CapabilityContext['scope'][] = [undefined, 'global', 'all', [], [script, script], Uri.parse('untitled:script.py')];
            const keys: EnvironmentManagerCapability[] = ['environments.create', 'environments.create.quick', 'environments.create.additionalPackages'];
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
    });

    test('pip advertises lookup without probing tool versions or selecting a backend', async () => {
        const manager = pip();
        const useUv = sinon.stub(helpers, 'shouldUseUv');
        const uvExecutable = sinon.stub(helpers, 'getUvExecutable');
        const runPython = sinon.stub(helpers, 'runPython');
        const runUv = sinon.stub(helpers, 'runUV');
        const lookup = sinon.stub(manager, 'getPackageAvailableVersions');
        assert.deepStrictEqual(await packageCapability(manager, 'packages.availableVersions'), { supported: true });
        assert.ok(useUv.notCalled && uvExecutable.notCalled && runPython.notCalled && runUv.notCalled && lookup.notCalled);
    });

    test('pip direct names remain best-effort and command-only inline restrictions are not capabilities', async () => {
        const manager = pip();
        const env = createMockPythonEnvironment({ envPath: path.join(root, 'inline'), managerId: 'ms-python.python:inline-script' });
        const direct = sinon.stub(manager, 'getDirectPackageNames');
        const manage = sinon.stub(manager, 'manage');
        for (const key of ['packages.direct', 'packages.manage', 'packages.manage.headless', 'packages.manage.upgrade', 'packages.manage.showSkipOption', 'packages.list.skipCache'] as const) {
            assert.deepStrictEqual(await packageCapability(manager, key, { environment: env }), { supported: true });
        }
        assert.deepStrictEqual(await packageCapability(manager, 'packages.direct'), { supported: true });
        assert.ok(direct.notCalled && manage.notCalled);
    });

    test('Poetry support uses its bound instance without validating request project identity', async () => {
        const manager = poetry();
        const first = manager.createForProject(project);
        const second = manager.createForProject(otherProject);
        disposables.push(first, second);
        const keys: PackageManagerCapability[] = ['packages.list', 'packages.list.skipCache', 'packages.direct', 'packages.manage', 'packages.manage.headless', 'packages.refresh'];
        for (const key of keys) {
            assertUnsupported(await packageCapability(manager, key, { project }));
            assert.deepStrictEqual(await packageCapability(first, key, { project }), { supported: true });
            assert.deepStrictEqual(await packageCapability(first, key, { project: otherProject }), { supported: true });
            assert.deepStrictEqual(await packageCapability(second, key, { project: otherProject }), { supported: true });
        }
        const extracted = first.capabilities['packages.list']!;
        assert.deepStrictEqual(await extracted({}), { supported: true });
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

    suite('exhaustive optional advertisements', () => {
        const environmentKeys: EnvironmentManagerCapability[] = [
            'environments.create', 'environments.create.quick', 'environments.create.additionalPackages',
            'environments.remove', 'environments.remove.headless', 'environments.clearCache',
            'environments.events.changed', 'environments.events.selectionChanged',
        ];
        const commonEnvironmentKeys: EnvironmentManagerCapability[] = [
            'environments.clearCache', 'environments.events.changed', 'environments.events.selectionChanged',
        ];
        const environmentManagers: {
            name: string;
            create: () => EnvironmentManager;
            supported: EnvironmentManagerCapability[];
        }[] = [
            {
                name: 'venv',
                create: venv,
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
                }
            });
        }

        const packageKeys: PackageManagerCapability[] = [
            'packages.direct', 'packages.version', 'packages.availableVersions', 'packages.formatInstallSpec',
            'packages.clearCache', 'packages.watchTargets', 'packages.events.changed',
        ];
        const packageManagers: {
            name: string;
            create: () => PackageManager;
            supported: PackageManagerCapability[];
        }[] = [
            {
                name: 'pip',
                create: () => pip(),
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
                }
            });
        }
    });
});
