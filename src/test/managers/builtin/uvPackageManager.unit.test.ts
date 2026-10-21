// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, Uri } from 'vscode';
import { PackageCapability, PythonEnvironmentApi } from '../../../api';
import * as errorUtils from '../../../common/errors/utils';
import * as windowApis from '../../../common/window.apis';
import { pythonToolSupport } from '../../../internal/pythonToolSupport';
import { UvListCommand } from '../../../managers/builtin/commands';
import * as helpers from '../../../managers/builtin/helpers';
import * as pipUtils from '../../../managers/builtin/pipUtils';
import { UvPackageManager } from '../../../managers/builtin/uvPackageManager';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('UvPackageManager', () => {
    const scope = Uri.file(path.join(process.cwd(), 'project with spaces'));
    const environment = createMockPythonEnvironment({
        envPath: path.join(scope.fsPath, '.venv'),
        version: '3.12.0',
        managerId: 'ms-python.python:venv',
    });
    let manager: UvPackageManager;
    let source: CancellationTokenSource;
    let createPackageItem: sinon.SinonStub;
    let getUvExecutable: sinon.SinonStub;
    let runUV: sinon.SinonStub;
    let runPython: sinon.SinonStub;

    setup(() => {
        source = new CancellationTokenSource();
        createPackageItem = sinon.stub().callsFake((info) => info);
        const api: Partial<PythonEnvironmentApi> = { createPackageItem };
        manager = new UvPackageManager(api as PythonEnvironmentApi, createMockLogOutputChannel(), {} as VenvManager);
        getUvExecutable = sinon.stub(helpers, 'getUvExecutable').resolves('workspace-uv');
        runUV = sinon.stub(helpers, 'runUV').resolves('[]');
        runPython = sinon.stub(helpers, 'runPython').rejects(new Error('Unexpected pip invocation'));
    });

    teardown(() => {
        manager.dispose();
        source.dispose();
        sinon.restore();
    });

    test('has a distinct identity and rejects Python 2 for every capability', async () => {
        assert.strictEqual(manager.name, 'uv');
        for (const capability of Object.values(manager.capabilities)) {
            assert.deepStrictEqual(await capability({ environment: { ...environment, version: '2.7.18' } }), {
                supported: false,
                reason: 'Python 2.* is not supported (deprecated)',
            });
            assert.deepStrictEqual(await capability({ environment }), { supported: true });
        }
        assert.ok(getUvExecutable.notCalled);
    });

    test('lists packages through uv and caches items owned by this manager', async () => {
        runUV.resolves(JSON.stringify([{ name: 'requests', version: '2.32.5' }]));
        const packages = await manager.getPackages(environment);
        assert.strictEqual(await manager.getPackages(environment), packages);
        assert.strictEqual(runUV.callCount, 1);
        assert.deepStrictEqual(runUV.firstCall.args[0], [
            'pip', 'list', '--format=json', '--python', environment.environmentPath.fsPath,
        ]);
        assert.strictEqual(runUV.firstCall.args[5], 'workspace-uv');
        assert.strictEqual(createPackageItem.firstCall.args[1], environment);
        assert.strictEqual(createPackageItem.firstCall.args[2], manager);
        assert.ok(runPython.notCalled);
    });

    test('uses uv for versions and dependency roots without querying pip', async () => {
        runUV.onFirstCall().resolves('uv 0.8.0');
        runUV.onSecondCall().resolves('Requests v2.32.5\n');
        runUV.onThirdCall().resolves(JSON.stringify({ versions: ['2.31.0', '2.32.5'] }));
        assert.strictEqual((await manager.getVersion(environment))?.public, '0.8.0');
        assert.deepStrictEqual(await manager.getDirectPackageNames(environment), new Set(['requests']));
        assert.deepStrictEqual(
            (await manager.getPackageAvailableVersions(environment, 'requests')).map((version) => version.public),
            ['2.32.5', '2.31.0'],
        );
        assert.deepStrictEqual(runUV.thirdCall.args[0], [
            'tool', 'run', 'pip', 'index', 'versions', 'requests', '--json', '--python-version', '3.12.0',
        ]);
        assert.ok(runPython.notCalled);
    });

    test('headless uninstall and upgrade preserve target, token, scope, and change events', async () => {
        const progress = sinon.stub(windowApis, 'withProgress').throws(new Error('Unexpected progress UI'));
        const changes = sinon.spy();
        manager.onDidChangePackages(changes);
        runUV.onThirdCall().resolves(JSON.stringify([{ name: 'requests', version: '2.32.5' }]));

        await manager[pythonToolSupport].manage(
            environment,
            { uninstall: ['old-package'], install: ['requests'], upgrade: true },
            source.token,
            scope,
        );

        assert.deepStrictEqual(runUV.firstCall.args[0], [
            'pip', 'uninstall', '--python', environment.environmentPath.fsPath, 'old-package',
        ]);
        assert.deepStrictEqual(runUV.secondCall.args[0], [
            'pip', 'install', '--python', environment.environmentPath.fsPath, '--upgrade', 'requests',
        ]);
        for (const call of runUV.getCalls()) {
            assert.strictEqual(call.args[3], source.token);
            assert.strictEqual(call.args[5], 'workspace-uv');
            assert.strictEqual(call.args[6], true);
        }
        assert.strictEqual(runUV.firstCall.args[1], undefined);
        assert.strictEqual(runUV.secondCall.args[1], scope.fsPath);
        assert.ok(getUvExecutable.alwaysCalledWithExactly(manager.log, environment.environmentPath.fsPath, source.token));
        assert.strictEqual(changes.firstCall.args[0].manager, manager);
        assert.strictEqual(changes.firstCall.args[0].environment, environment);
        assert.ok(progress.notCalled);
        assert.ok(runPython.notCalled);
    });

    test('uses uv inventory in the interactive package picker', async () => {
        const picker = sinon.stub(pipUtils, 'getWorkspacePackagesToInstall').callsFake(
            async (_api, _options, _projects, _environment, _log, listPackages) => {
                assert.ok(listPackages);
                await listPackages();
                return undefined;
            },
        );
        const api = {} as PythonEnvironmentApi;
        const interactive = new UvPackageManager(api, manager.log, {
            getProjectsByEnvironment: () => [],
        } as unknown as VenvManager);
        try {
            await interactive.manage(environment, { install: [] });
            assert.ok(picker.calledOnce);
            assert.ok(runUV.calledOnce);
            assert.ok(runPython.notCalled);
        } finally {
            interactive.dispose();
        }
    });

    test('reports unavailable uv without falling back to pip or showing headless UI', async () => {
        getUvExecutable.resolves(undefined);
        const errors = sinon.stub(windowApis, 'showErrorMessage');
        await assert.rejects(
            manager.manage(environment, { install: ['requests'], runHeadless: true }),
            /uv is unavailable/,
        );
        assert.ok(runUV.notCalled && runPython.notCalled && errors.notCalled);
    });

    test('explicit uv selection is independent of automatic uv selection', async () => {
        const shouldUseUv = sinon.stub(helpers, 'shouldUseUv').resolves(false);
        await manager.getPackages(environment);
        assert.ok(runUV.calledOnce);
        assert.ok(runPython.notCalled);
        assert.ok(shouldUseUv.notCalled);
    });

    test('preserves public cached packages on failure but tool inventory rejects', async () => {
        const errors = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();
        const list = sinon.stub(UvListCommand.prototype, 'execute').resolves([
            { name: 'requests', displayName: 'requests', version: '2.32.5' },
        ]);
        const cached = await manager.getPackages(environment);
        list.rejects(new Error('uv list failed'));
        assert.strictEqual(await manager.getPackages(environment, { skipCache: true }), cached);
        await assert.rejects(
            manager[pythonToolSupport].getPackages(environment, source.token, scope),
            /uv list failed/,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(errors.calledOnce);
    });

    test('cancellation stops tool execution before resolving uv', async () => {
        source.cancel();
        await assert.rejects(
            manager[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope),
            CancellationError,
        );
        assert.ok(getUvExecutable.notCalled && runUV.notCalled);
    });

    test('rejects Python 2 mutations before resolving uv', async () => {
        await assert.rejects(
            manager.manage({ ...environment, version: '2.7.18' }, { install: ['requests'], runHeadless: true }),
            /Python 2/,
        );
        assert.ok(getUvExecutable.notCalled && runUV.notCalled);
        assert.strictEqual((await manager.capabilities[PackageCapability.Install]({ environment })).supported, true);
    });
});
