// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, Memento, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi, PythonProject } from '../../api';
import {
    Capabilities,
    CapabilityContext,
    ManagerCapability,
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
    const environmentHooks = [
        'environments.clearCache', 'environments.events.changed', 'environments.events.selectionChanged',
    ] as const;
    let api: PythonEnvironmentApi;
    let log: ReturnType<typeof createMockLogOutputChannel>;
    const disposables: Disposable[] = [];

    function venv(): VenvManager {
        return new VenvManager({} as NativePythonFinder, api, {} as EnvironmentManager, log);
    }

    async function assertAdvertised<C extends ManagerCapability>(
        capabilities: Capabilities<C>,
        keys: readonly C[],
        context: CapabilityContext = {},
    ): Promise<void> {
        for (const key of keys) {
            const check = capabilities[key];
            assert.ok(check, `Missing advertisement: ${key}`);
            assert.deepStrictEqual(await check(context), { supported: true }, key);
        }
    }

    function assertUnsupported(result: Support): void {
        assert.strictEqual(result.supported, false);
        if (!result.supported) {
            assert.ok(result.reason.length > 0);
        }
    }

    async function assertQuickCreation(manager: VenvManager | CondaEnvManager): Promise<void> {
        const create = sinon.stub(manager, 'create').rejects(new Error('Unexpected creation'));
        (api.getPythonProject as sinon.SinonStub).returns(undefined);
        await assertAdvertised(manager.capabilities, [
            ...environmentHooks, 'environments.create', 'environments.remove', 'environments.create.quick',
        ]);
        for (const key of ['environments.create.additionalPackages', 'environments.remove.headless'] as const) {
            assert.deepStrictEqual(await environmentCapability(manager, key), { supported: true });
        }
        const denied: Support = { supported: false, reason: 'Disabled by provider' };
        sinon.stub(manager, 'capabilities').value({ ...manager.capabilities, 'environments.create': async () => denied });
        assert.strictEqual(await environmentCapability(manager, 'environments.create.quick'), denied);
        assert.ok(create.notCalled);
        assert.ok((api.getPythonProject as sinon.SinonStub).notCalled);
    }

    setup(() => {
        api = {
            getPythonProject: sinon.stub().returns(project),
            getPythonProjects: sinon.stub().returns([project]),
            getEnvironments: sinon.stub().rejects(new Error('Unexpected environment discovery')),
        } as unknown as PythonEnvironmentApi;
        log = createMockLogOutputChannel();
        sinon.stub(windowApis, 'showErrorMessage').rejects(new Error('Unexpected prompt'));
        sinon.stub(windowApis, 'showQuickPick').rejects(new Error('Unexpected picker'));
        sinon.stub(childProcessApis, 'spawnProcess').throws(new Error('Unexpected process'));
    });

    teardown(() => {
        try {
            for (const disposable of disposables.splice(0)) {
                disposable.dispose();
            }
            sinon.assert.notCalled(windowApis.showErrorMessage as sinon.SinonStub);
            sinon.assert.notCalled(windowApis.showQuickPick as sinon.SinonStub);
            sinon.assert.notCalled(childProcessApis.spawnProcess as sinon.SinonStub);
        } finally {
            sinon.restore();
        }
    });

    suite('Venv', () => {
        test('advertises creation and provider hooks without runtime preflight', async () => {
            await assertQuickCreation(venv());
        });
    });

    suite('System Python', () => {
        test('advertises provider hooks but rejects unsupported creation options and removal', async () => {
            const manager = new SysPythonManager({} as NativePythonFinder, api, log);
            const create = sinon.stub(manager, 'create');
            await assertAdvertised(manager.capabilities, [...environmentHooks, 'environments.create']);
            for (const key of ['environments.create.quick', 'environments.create.additionalPackages', 'environments.remove'] as const) {
                assertUnsupported(await environmentCapability(manager, key));
            }
            assert.ok(create.notCalled);
        });
    });

    suite('Conda', () => {
        test('advertises creation and provider hooks without runtime preflight', async () => {
            const manager = new CondaEnvManager({} as NativePythonFinder, api, log);
            disposables.push(manager);
            await assertQuickCreation(manager);
        });

        test('advertises package lookup and watching but not direct names or cache clearing', async () => {
            const manager = new CondaPackageManager(api, log);
            disposables.push(manager);
            await assertAdvertised(manager.capabilities, [
                'packages.version', 'packages.availableVersions', 'packages.watchTargets', 'packages.events.changed',
            ]);
            for (const key of ['packages.direct', 'packages.clearCache'] as const) {
                assertUnsupported(await packageCapability(manager, key));
            }
        });
    });

    suite('Inline scripts', () => {
        let manager: InlineScriptEnvManager;
        let readMetadata: sinon.SinonStub;
        let stateUpdate: sinon.SinonStub;
        const script = Uri.file(path.join(root, 'script.py'));
        const creationKeys = [
            'environments.create', 'environments.create.quick', 'environments.create.additionalPackages',
        ] as const;

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

        test('advertises provider hooks but not URI resolution', async () => {
            const resolve = sinon.stub(manager, 'resolve');
            await assertAdvertised(manager.capabilities, [...environmentHooks, 'environments.remove']);
            assertUnsupported(await environmentCapability(manager, 'environments.resolve', { scope: script }));
            assert.ok(resolve.notCalled && stateUpdate.notCalled && readMetadata.notCalled);
        });

        test('valid local script supports quick creation without quickCreateConfig or mutations', async () => {
            const create = sinon.stub(manager, 'create');
            const remove = sinon.stub(manager, 'remove');
            const select = sinon.stub(manager, 'set');
            assert.strictEqual((manager as EnvironmentManager).quickCreateConfig, undefined);
            await assertAdvertised(manager.capabilities, ['environments.create', 'environments.create.quick'], { scope: script });
            for (const scope of [script, [script]]) {
                for (const key of creationKeys) {
                    assert.deepStrictEqual(await environmentCapability(manager, key, { scope }), { supported: true });
                }
            }
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.remove.headless'), { supported: true });
            assert.ok(create.notCalled && remove.notCalled && select.notCalled && stateUpdate.notCalled);
            assert.ok((api.getEnvironments as sinon.SinonStub).notCalled);
            assert.ok(readMetadata.alwaysCalledWithExactly(script));
        });

        test('invalid scopes and missing metadata disable creation; probe failures reject', async () => {
            const scopes: CapabilityContext['scope'][] = [undefined, 'global', 'all', [], [script, script], Uri.parse('untitled:script.py')];
            for (const scope of scopes) {
                for (const key of creationKeys) {
                    assertUnsupported(await environmentCapability(manager, key, { scope }));
                }
            }
            assert.ok(readMetadata.notCalled);
            readMetadata.resolves(undefined);
            for (const key of creationKeys) {
                assertUnsupported(await environmentCapability(manager, key, { scope: script }));
            }
            readMetadata.rejects(new Error('Metadata probe failed'));
            await assert.rejects(environmentCapability(manager, 'environments.create.quick', { scope: script }), /Metadata probe failed/);
            assert.ok(stateUpdate.notCalled);
        });
    });

    suite('Pip', () => {
        let manager: PipPackageManager;

        setup(() => {
            manager = new PipPackageManager(api, log, venv());
            disposables.push(manager);
        });

        test('advertises package hooks without probing versions or selecting a backend', async () => {
            const useUv = sinon.stub(helpers, 'shouldUseUv');
            const uvExecutable = sinon.stub(helpers, 'getUvExecutable');
            const runPython = sinon.stub(helpers, 'runPython');
            const runUv = sinon.stub(helpers, 'runUV');
            const lookup = sinon.stub(manager, 'getPackageAvailableVersions');
            await assertAdvertised(manager.capabilities, [
                'packages.version', 'packages.events.changed', 'packages.availableVersions', 'packages.direct',
            ]);
            for (const key of ['packages.clearCache', 'packages.watchTargets'] as const) {
                assertUnsupported(await packageCapability(manager, key));
            }
            assert.ok(useUv.notCalled && uvExecutable.notCalled && runPython.notCalled && runUv.notCalled && lookup.notCalled);
        });

        test('command-only inline restrictions do not disable manager capabilities', async () => {
            const environment = createMockPythonEnvironment({ envPath: path.join(root, 'inline'), managerId: 'ms-python.python:inline-script' });
            const direct = sinon.stub(manager, 'getDirectPackageNames');
            const manage = sinon.stub(manager, 'manage');
            for (const key of ['packages.direct', 'packages.manage', 'packages.manage.headless', 'packages.manage.upgrade', 'packages.manage.showSkipOption', 'packages.list.skipCache'] as const) {
                assert.deepStrictEqual(await packageCapability(manager, key, { environment }), { supported: true });
            }
            assert.ok(direct.notCalled && manage.notCalled);
        });
    });

    suite('Poetry', () => {
        test('advertises environment provider hooks but not creation or removal', async () => {
            const manager = new PoetryManager({} as NativePythonFinder, api);
            disposables.push(manager);
            await assertAdvertised(manager.capabilities, environmentHooks);
            for (const key of ['environments.create', 'environments.remove'] as const) {
                assertUnsupported(await environmentCapability(manager, key));
            }
        });

        test('package support requires a bound instance, not matching request project identity', async () => {
            const rootManager = new PoetryPackageManager(api, log, {} as PoetryManager);
            disposables.push(rootManager);
            const manager = rootManager.createForProject(project);
            disposables.push(manager);
            await assertAdvertised(manager.capabilities, [
                'packages.version', 'packages.events.changed', 'packages.list', 'packages.direct', 'packages.manage', 'packages.refresh',
            ]);
            for (const key of ['packages.list', 'packages.list.skipCache', 'packages.direct', 'packages.manage', 'packages.manage.headless', 'packages.refresh'] as const) {
                assertUnsupported(await packageCapability(rootManager, key, { project }));
                assert.deepStrictEqual(await packageCapability(manager, key, { project: otherProject }), { supported: true });
            }
            const lookup = sinon.stub(manager, 'getPackageAvailableVersions');
            const manage = sinon.stub(manager, 'manage');
            for (const key of ['packages.availableVersions', 'packages.manage.upgrade', 'packages.manage.showSkipOption', 'packages.clearCache', 'packages.watchTargets'] as const) {
                assertUnsupported(await packageCapability(manager, key, { project }));
            }
            assert.ok(lookup.notCalled && manage.notCalled);
        });
    });

    suite('Pipenv', () => {
        test('advertises environment provider hooks but not creation or removal', async () => {
            const manager = new PipenvManager({} as NativePythonFinder, api);
            disposables.push(manager);
            await assertAdvertised(manager.capabilities, environmentHooks);
            for (const key of ['environments.create', 'environments.remove'] as const) {
                assertUnsupported(await environmentCapability(manager, key));
            }
        });
    });

    suite('Pyenv', () => {
        test('advertises environment provider hooks but not creation or removal', async () => {
            const manager = new PyEnvManager({} as NativePythonFinder, api);
            disposables.push(manager);
            await assertAdvertised(manager.capabilities, environmentHooks);
            for (const key of ['environments.create', 'environments.remove'] as const) {
                assertUnsupported(await environmentCapability(manager, key));
            }
        });
    });
});
