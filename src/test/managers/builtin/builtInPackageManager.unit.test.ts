// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, Uri } from 'vscode';
import { PackageCapability, PythonEnvironmentApi } from '../../../api';
import { pythonToolSupport } from '../../../internal/pythonToolSupport';
import { BuiltInPackageManager } from '../../../managers/builtin/builtInPackageManager';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import { UvPackageManager } from '../../../managers/builtin/uvPackageManager';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('BuiltInPackageManager routing', () => {
    const scope = Uri.file(path.join(process.cwd(), 'routing project'));
    const environment = createMockPythonEnvironment({
        envPath: path.join(scope.fsPath, '.venv'), version: '3.12.0',
    });
    let manager: BuiltInPackageManager;
    let pip: PipPackageManager;
    let uv: UvPackageManager;
    let source: CancellationTokenSource;
    let shouldUseUv: sinon.SinonStub;
    let createPackageItem: sinon.SinonStub;

    setup(() => {
        source = new CancellationTokenSource();
        createPackageItem = sinon.stub().callsFake((info) => info);
        const api: Partial<PythonEnvironmentApi> = { createPackageItem };
        const log = createMockLogOutputChannel();
        const venv = {} as VenvManager;
        uv = new UvPackageManager(api as PythonEnvironmentApi, log, venv);
        pip = new PipPackageManager(api as PythonEnvironmentApi, log, venv);
        manager = new BuiltInPackageManager(pip, uv);
        shouldUseUv = sinon.stub(helpers, 'shouldUseUv').resolves(true);
    });

    teardown(() => {
        manager.dispose();
        uv.dispose();
        source.dispose();
        sinon.restore();
    });

    for (const useUv of [false, true]) {
        test(`preserves registered package and event identity for ${useUv ? 'uv' : 'pip'}`, async () => {
            shouldUseUv.resolves(useUv);
            if (useUv) {
                sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
            }
            const run = sinon.stub(helpers, useUv ? 'runUV' : 'runPython').resolves('');
            run.onSecondCall().resolves(JSON.stringify([{ name: 'requests', version: '2.32.5' }]));
            const changes = sinon.spy();
            const owner = useUv ? uv : manager;
            const subscription = owner.onDidChangePackages(changes);
            try {
                await manager.manage(environment, { install: ['requests'], runHeadless: true }, source.token, scope);
                assert.strictEqual(createPackageItem.firstCall.args[2], owner);
                assert.strictEqual(changes.firstCall.args[0].manager, owner);
                assert.strictEqual(changes.firstCall.args[0].environment, environment);
            } finally {
                subscription.dispose();
            }
        });

        test(`routes package operations to ${useUv ? 'uv' : 'pip'} using shouldUseUv`, async () => {
            shouldUseUv.resolves(useUv);
            const pipManage = sinon.stub(PipPackageManager.prototype, 'manage').resolves();
            const uvManage = sinon.stub(uv, 'manage').resolves();
            const pipRefresh = sinon.stub(PipPackageManager.prototype, 'refresh').resolves();
            const uvRefresh = sinon.stub(uv, 'refresh').resolves();
            const pipList = sinon.stub(PipPackageManager.prototype, 'getPackages').resolves([]);
            const uvList = sinon.stub(uv, 'getPackages').resolves([]);
            const pipVersion = sinon.stub(PipPackageManager.prototype, 'getVersion').resolves();
            const uvVersion = sinon.stub(uv, 'getVersion').resolves();
            const pipVersions = sinon.stub(PipPackageManager.prototype, 'getPackageAvailableVersions').resolves([]);
            const uvVersions = sinon.stub(uv, 'getPackageAvailableVersions').resolves([]);
            const pipDirect = sinon.stub(PipPackageManager.prototype, 'getDirectPackageNames').resolves(new Set());
            const uvDirect = sinon.stub(uv, 'getDirectPackageNames').resolves(new Set());
            const options = { install: ['requests'], runHeadless: true };

            await manager.manage(environment, options, source.token, scope);
            await manager.refresh(environment);
            await manager.getPackages(environment, { skipCache: true });
            await manager.getVersion(environment);
            await manager.getPackageAvailableVersions(environment, 'requests');
            await manager.getDirectPackageNames(environment);

            for (const [pipCall, uvCall] of [
                [pipManage, uvManage], [pipRefresh, uvRefresh], [pipList, uvList],
                [pipVersion, uvVersion], [pipVersions, uvVersions], [pipDirect, uvDirect],
            ]) {
                assert.strictEqual(pipCall.callCount, useUv ? 0 : 1);
                assert.strictEqual(uvCall.callCount, useUv ? 1 : 0);
            }
            assert.ok((useUv ? uvManage : pipManage).calledOnceWithExactly(environment, options, source.token, scope));
            assert.ok(shouldUseUv.firstCall.calledWithExactly(
                pip.log, environment.environmentPath.fsPath, environment.environmentPath.fsPath, source.token,
            ));
        });
    }

    test('uses uv version lookup without querying the environment pip', async () => {
        const executable = sinon.stub(helpers, 'getUvExecutable').resolves('workspace-uv');
        const runPython = sinon.stub(helpers, 'runPython');
        const runUV = sinon.stub(helpers, 'runUV').resolves(JSON.stringify({ versions: ['2.31.0', '2.32.5'] }));

        const versions = await manager.getPackageAvailableVersions(environment, 'requests');

        assert.ok(runPython.notCalled);
        assert.ok(shouldUseUv.calledOnceWithExactly(
            pip.log, environment.environmentPath.fsPath, environment.environmentPath.fsPath, undefined,
        ));
        assert.ok(executable.calledOnceWithExactly(pip.log, environment.environmentPath.fsPath, undefined));
        assert.strictEqual(runUV.firstCall.args[5], 'workspace-uv');
        assert.deepStrictEqual(versions.map((version) => version.public), ['2.32.5', '2.31.0']);
    });

    test('routes tool inventory with its cancellation token and no public cache fallback', async () => {
        const getPackages = sinon.stub(uv[pythonToolSupport], 'getPackages').resolves([]);
        await manager[pythonToolSupport].getPackages(environment, source.token, scope);
        assert.ok(getPackages.calledOnceWithExactly(environment, source.token, scope));
        assert.strictEqual(shouldUseUv.firstCall.args[3], source.token);
    });

    test('routes tool inventory to strict pip reads when uv is not selected', async () => {
        shouldUseUv.resolves(false);
        sinon.stub(helpers, 'runPython').resolves('not json');
        await assert.rejects(manager[pythonToolSupport].getPackages(environment, source.token, scope));
    });

    test('uses the selected manager capability checks', async () => {
        const unsupported = { ...environment, version: '2.7.18' };
        assert.strictEqual((await manager.capabilities[PackageCapability.List]({ environment: unsupported })).supported, false);
        shouldUseUv.resolves(false);
        assert.strictEqual((await manager.capabilities[PackageCapability.List]({ environment: unsupported })).supported, true);
        assert.strictEqual((await manager.capabilities[PackageCapability.FetchAvailableVersions]({})).supported, false);
    });

    test('headless no-ops and unsupported mutations do not probe uv', async () => {
        await manager.manage(environment, { install: [], runHeadless: true });
        await assert.rejects(
            manager.manage({ ...environment, version: '2.7.18' }, { install: ['requests'], runHeadless: true }),
            /Python 2/,
        );
        assert.ok(shouldUseUv.notCalled);
    });

    test('rechecks the routing rules for each operation', async () => {
        const uvList = sinon.stub(uv, 'getPackages').resolves([]);
        const pipList = sinon.stub(PipPackageManager.prototype, 'getPackages').resolves([]);
        await manager.getPackages(environment);
        shouldUseUv.resolves(false);
        await manager.getPackages(environment);
        assert.ok(uvList.calledOnce && pipList.calledOnce);
    });

    test('cancellation stops routing before the uv probe', async () => {
        source.cancel();
        await assert.rejects(
            manager[pythonToolSupport].getPackages(environment, source.token, scope), CancellationError,
        );
        assert.ok(shouldUseUv.notCalled);
    });

    test('probe errors propagate instead of silently falling back', async () => {
        const error = new Error('uv probe failed');
        shouldUseUv.rejects(error);
        await assert.rejects(manager.getPackages(environment), (actual: unknown) => actual === error);
    });
});
