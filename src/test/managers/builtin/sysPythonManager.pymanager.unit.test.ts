// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationTokenSource, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { normalizePath } from '../../../common/utils/pathUtils';
import { createDeferred } from '../../../common/utils/deferred';
import * as cache from '../../../managers/builtin/cache';
import * as installer from '../../../managers/builtin/pythonInstaller';
import * as pim from '../../../managers/builtin/pymanagerPythonInstaller';
import { SysPythonManager } from '../../../managers/builtin/sysPythonManager';
import * as utils from '../../../managers/builtin/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('System Python PyManager integration', () => {
    let sandbox: sinon.SinonSandbox;
    let root: string;
    let manager: SysPythonManager;
    let native: PythonEnvironment;
    let nativeRefresh: sinon.SinonStub;
    let resolve: sinon.SinonStub;
    let detect: sinon.SinonStub;
    let list: sinon.SinonStub;
    let prompt: sinon.SinonStub;
    let select: sinon.SinonStub;
    let showError: sinon.SinonStub;
    let setGlobal: sinon.SinonStub;
    let getProjects: sinon.SinonStub;
    let workspaceSelection: sinon.SinonStub;
    let globalSelection: sinon.SinonStub;
    let cancellation: CancellationTokenSource;

    function environment(executable: string, version = '3.12.0'): PythonEnvironment {
        return {
            envId: { managerId: 'ms-python.python:system', id: executable + version },
            name: `Python ${version}`,
            displayName: `Python ${version}`,
            displayPath: executable,
            environmentPath: Uri.file(executable),
            sysPrefix: path.dirname(executable),
            version,
            execInfo: { run: { executable } },
        };
    }

    async function runtime(version = '3.14.6'): Promise<pim.PymanagerRuntime> {
        const prefix = path.join(root, 'pim-runtime');
        const executable = path.join(prefix, 'python.exe');
        await fs.outputFile(executable, '');
        return {
            id: 'pythoncore-3.14-64',
            company: 'PythonCore',
            version,
            tag: '3.14-64',
            installTags: [`${version}-64`],
            executable,
            executableArgs: [],
            prefix,
            unmanaged: false,
        };
    }

    setup(async () => {
        sandbox = sinon.createSandbox();
        cancellation = new CancellationTokenSource();
        root = await nativeFs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pim-system-unit-')));
        native = environment(path.join(root, 'legacy', 'python.exe'));
        await fs.outputFile(native.execInfo.run.executable, '');
        sandbox.stub(windowApis, 'withProgress').callsFake(async (_options, action) =>
            action({ report: () => undefined }, cancellation.token));
        nativeRefresh = sandbox.stub(utils, 'refreshPythons').resolves([native]);
        resolve = sandbox.stub(utils, 'resolveSystemPythonEnvironmentPath').resolves(undefined);
        detect = sandbox.stub(pim, 'detectPymanager').resolves({ kind: 'absent' });
        list = sandbox.stub(pim, 'listPymanagerRuntimes').resolves([]);
        prompt = sandbox.stub(installer, 'promptInstallPython').resolves(undefined);
        select = sandbox.stub(installer, 'selectAndInstallPython').resolves(undefined);
        showError = sandbox.stub(windowApis, 'showErrorMessage').resolves(undefined);
        globalSelection = sandbox.stub(cache, 'getSystemEnvForGlobal').resolves(undefined);
        workspaceSelection = sandbox.stub(cache, 'getSystemEnvForWorkspace').resolves(undefined);
        setGlobal = sandbox.stub(cache, 'setSystemEnvForGlobal').resolves();
        let nextId = 0;
        getProjects = sandbox.stub().returns([]);
        const api = {
            getPythonProjects: getProjects,
            getPythonProject: () => undefined,
            getEnvironments: async () => { throw new Error('Do not re-enter global enumeration during initialization'); },
            createPythonEnvironmentItem: (info: PythonEnvironmentInfo) => ({
                ...info,
                envId: { managerId: 'ms-python.python:system', id: `system-${nextId++}` },
            }),
        } as unknown as PythonEnvironmentApi;
        manager = new SysPythonManager({} as NativePythonFinder, api, createMockLogOutputChannel());
    });

    teardown(async () => {
        cancellation.dispose();
        sandbox.restore();
        await fs.remove(root);
    });

    test('keeps native Python and does not prompt when PyManager is absent', async () => {
        assert.deepStrictEqual(await manager.getEnvironments('global'), [native]);
        sinon.assert.notCalled(prompt);
        sinon.assert.notCalled(list);
    });

    test('delegates missing-Python acquisition without re-entering the environment API', async () => {
        nativeRefresh.resolves([]);
        const installed = environment(path.join(root, 'installed', 'python.exe'), '3.14.6');
        prompt.resolves(installed.execInfo.run.executable);
        resolve.resolves(installed);

        assert.deepStrictEqual(await manager.getEnvironments('global'), [installed]);

        sinon.assert.calledOnceWithExactly(prompt, 'activation', manager.log);
        sinon.assert.calledOnceWithExactly(setGlobal, installed.environmentPath.fsPath);
    });

    test('discovers manager-owned Python even when it has no registry result', async () => {
        const managed = await runtime();
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);

        const environments = await manager.getEnvironments('global');
        const discovered = environments.find((item) => normalizePath(item.execInfo.run.executable) === normalizePath(managed.executable));

        assert.strictEqual(environments.length, 2);
        assert.ok(discovered);
        assert.strictEqual(discovered.envId.managerId, 'ms-python.python:system');
        assert.strictEqual(discovered.version, '3.14.6');
        sinon.assert.notCalled(prompt);
        sinon.assert.notCalled(resolve);
    });

    test('exposes the first installed Python through PyManager when native resolution misses it', async () => {
        const managed = await runtime();
        nativeRefresh.resolves([]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.onFirstCall().resolves([]).onSecondCall().resolves([managed]);
        prompt.resolves(managed.executable);

        const environments = await manager.getEnvironments('global');

        assert.strictEqual(environments.length, 1);
        assert.strictEqual(environments[0].version, managed.version);
        sinon.assert.calledOnceWithExactly(setGlobal, environments[0].environmentPath.fsPath);
        sinon.assert.notCalled(resolve);
        sinon.assert.notCalled(showError);
    });

    test('reports an installed Python that cannot be exposed by the environment API', async () => {
        nativeRefresh.resolves([]);
        prompt.resolves(path.join(root, 'unresolved', 'python.exe'));

        assert.deepStrictEqual(await manager.getEnvironments('global'), []);

        sinon.assert.calledOnce(showError);
        sinon.assert.notCalled(setGlobal);
    });

    test('refreshes an in-place update instead of retaining an older native version', async () => {
        const managed = await runtime('3.14.7');
        nativeRefresh.resolves([environment(managed.executable, '3.14.6')]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);

        const environments = await manager.getEnvironments('global');

        assert.strictEqual(environments.length, 1);
        assert.strictEqual(environments[0].version, '3.14.7');
    });

    test('retains previously discovered PyManager entries on transient listing failure', async () => {
        const managed = await runtime();
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        await manager.getEnvironments('global');
        list.rejects(new Error('manager busy'));

        await manager.refresh(undefined);

        const environments = await manager.getEnvironments('global');
        assert.ok(environments.some((item) => item.version === managed.version));
        assert.ok(environments.includes(native));
    });

    test('removes previously discovered PyManager entries when the manager is no longer installed', async () => {
        const managed = await runtime();
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        await manager.getEnvironments('global');
        detect.resolves({ kind: 'absent' });

        await manager.refresh(undefined);

        assert.deepStrictEqual(await manager.getEnvironments('global'), [native]);
    });

    test('does not discard native results when PyManager is unusable', async () => {
        detect.resolves({ kind: 'unusable', executable: path.join(root, 'pymanager.exe'), error: new Error('denied') });
        assert.deepStrictEqual(await manager.getEnvironments('global'), [native]);
        sinon.assert.notCalled(prompt);
    });

    test('removes a PyManager entry after a successful empty inventory', async () => {
        const managed = await runtime();
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        await manager.getEnvironments('global');
        list.resolves([]);
        await manager.refresh(undefined);
        assert.deepStrictEqual(await manager.getEnvironments('global'), [native]);
    });

    test('ignores launchers, relative executables and derived environments', async () => {
        const managed = await runtime();
        await fs.outputFile(path.join(managed.prefix!, 'pyvenv.cfg'), 'home = base\n');
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([
            managed,
            { ...managed, executable: 'python.exe' },
            { ...managed, executable: path.join(root, 'pymanager.exe') },
        ]);
        assert.deepStrictEqual(await manager.getEnvironments('global'), [native]);
    });

    test('global creation refreshes and selects the verified newly installed version', async () => {
        const managed = await runtime('3.14.7');
        nativeRefresh.resolves([environment(managed.executable, '3.14.6')]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        select.resolves(managed.executable);

        const created = await manager.create('global', undefined);

        assert.strictEqual(created?.version, '3.14.7');
        sinon.assert.calledOnceWithExactly(select, manager.log);
        sinon.assert.calledOnceWithExactly(setGlobal, created!.environmentPath.fsPath);
        sinon.assert.notCalled(resolve);
    });

    test('resolves an updated runtime directly rather than selecting stale inventory after refresh failure', async () => {
        const executable = path.join(root, 'updated', 'python.exe');
        nativeRefresh.resolves([environment(executable, '3.14.6')]);
        await manager.getEnvironments('global');
        nativeRefresh.rejects(new Error('native refresh failed'));
        const updated = environment(executable, '3.14.7');
        select.resolves(executable);
        resolve.resolves(updated);

        assert.strictEqual(await manager.create('global', undefined), updated);

        sinon.assert.calledOnce(resolve);
        sinon.assert.calledOnceWithExactly(setGlobal, updated.environmentPath.fsPath);
        sinon.assert.notCalled(showError);
    });

    test('does not select retained PyManager metadata after supplemental discovery fails during an update', async () => {
        const managed = await runtime('3.14.6');
        nativeRefresh.resolves([]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        await manager.getEnvironments('global');
        list.rejects(new Error('PyManager is temporarily unavailable'));
        const updated = environment(managed.executable, '3.14.7');
        select.resolves(managed.executable);
        resolve.resolves(updated);

        assert.strictEqual(await manager.create('global', undefined), updated);

        sinon.assert.calledOnceWithExactly(resolve, managed.executable, sinon.match.any, sinon.match.any, manager);
        sinon.assert.calledOnceWithExactly(setGlobal, updated.environmentPath.fsPath);
        sinon.assert.notCalled(showError);
    });

    test('reports unverifiable installation rather than returning retained PyManager metadata', async () => {
        const managed = await runtime('3.14.6');
        nativeRefresh.resolves([]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        await manager.getEnvironments('global');
        list.rejects(new Error('PyManager is temporarily unavailable'));
        select.resolves(managed.executable);

        assert.strictEqual(await manager.create('global', undefined), undefined);

        sinon.assert.calledOnce(resolve);
        sinon.assert.calledOnce(showError);
        sinon.assert.notCalled(setGlobal);
    });

    test('keeps retained inventory and post-install selection consistent with an overlapping gated refresh', async () => {
        const managed = await runtime('3.14.6');
        nativeRefresh.resolves([]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.onCall(0).resolves([managed]);
        await manager.getEnvironments('global');
        list.onCall(1).rejects(new Error('Temporary supplemental lookup failure'));
        list.onCall(2).resolves([{ ...managed, version: '3.14.7' }]);
        const updated = environment(managed.executable, '3.14.7');
        select.resolves(managed.executable);
        resolve.resolves(updated);
        const postRefreshLoadStarted = createDeferred<void>();
        const releasePostRefreshLoad = createDeferred<void>();
        const inspectionStarted = createDeferred<void>();
        const releaseInspection = createDeferred<void>();
        globalSelection.onCall(1).callsFake(async () => {
            postRefreshLoadStarted.resolve();
            await releasePostRefreshLoad.promise;
            return undefined;
        });
        sandbox.stub(nativeFs, 'realpath').callThrough().withArgs(managed.executable).callsFake(async () => {
            inspectionStarted.resolve();
            await releaseInspection.promise;
            return managed.executable;
        });

        const creation = manager.create('global', undefined);
        let overlapping: Promise<void> | undefined;
        try {
            await Promise.race([
                postRefreshLoadStarted.promise,
                creation.then(() => { throw new Error('Creation completed before reaching the refresh gate'); }),
            ]);
            overlapping = manager.refresh(undefined);
            await new Promise<void>((done) => setImmediate(done));
            assert.strictEqual(list.callCount, 2, 'The next refresh must not change freshness during selection');
            releasePostRefreshLoad.resolve();
            assert.strictEqual(await creation, updated);
            await inspectionStarted.promise;
            assert.strictEqual((await manager.getEnvironments('global'))[0].version, '3.14.7');
            releaseInspection.resolve();
            await overlapping;
            assert.strictEqual((await manager.getEnvironments('global'))[0].version, '3.14.7');
            sinon.assert.calledOnce(resolve);
        } finally {
            releasePostRefreshLoad.resolve();
            releaseInspection.resolve();
            await Promise.allSettled([creation, ...(overlapping ? [overlapping] : [])]);
        }
    });

    test('refreshes metadata for a project already selecting the updated runtime without rewriting its selection', async () => {
        const managed = await runtime('3.14.6');
        const project = { name: 'workspace', uri: Uri.file(path.join(root, 'workspace')) };
        getProjects.returns([project]);
        workspaceSelection.resolves(managed.executable);
        const writeWorkspace = sandbox.stub(cache, 'setSystemEnvForWorkspace').resolves();
        nativeRefresh.resolves([]);
        detect.resolves({ kind: 'available', executable: path.join(root, 'pymanager.exe') });
        list.resolves([managed]);
        await manager.getEnvironments('global');
        assert.strictEqual((await manager.get(project.uri))?.version, '3.14.6');
        list.rejects(new Error('PyManager is temporarily unavailable'));
        const updated = environment(managed.executable, '3.14.7');
        select.resolves(managed.executable);
        resolve.resolves(updated);

        await manager.create('global', undefined);

        assert.strictEqual(await manager.get(project.uri), updated);
        sinon.assert.notCalled(writeWorkspace);
    });

    test('cancelling global creation changes no selection or inventory', async () => {
        assert.strictEqual(await manager.create('global', undefined), undefined);
        sinon.assert.notCalled(nativeRefresh);
        sinon.assert.notCalled(setGlobal);
    });

    test('reports unresolved global creation instead of silently returning after installation', async () => {
        select.resolves(path.join(root, 'unresolved', 'python.exe'));

        assert.strictEqual(await manager.create('global', undefined), undefined);

        sinon.assert.calledOnce(showError);
        sinon.assert.notCalled(setGlobal);
    });
});
