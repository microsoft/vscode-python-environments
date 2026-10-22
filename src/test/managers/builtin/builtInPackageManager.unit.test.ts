// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, Uri } from 'vscode';
import { PackageCapability, PackageChangeKind, PythonEnvironmentApi } from '../../../api';
import { createDeferred } from '../../../common/utils/deferred';
import * as windowApis from '../../../common/window.apis';
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
        envPath: path.join(scope.fsPath, '.venv'),
        version: '3.12.0',
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
        test(`${useUv ? 'uv' : 'pip'} refresh after external changes invalidates peer cache while preserving other environments`, async () => {
            sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
            sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({ report: () => undefined }, source.token));
            const peer = useUv ? pip : uv;
            const backend = useUv ? uv : pip;
            const otherEnvironment = createMockPythonEnvironment({
                envPath: path.join(scope.fsPath, 'other-venv'),
                version: '3.12.0',
                id: 'other-environment',
            });
            const before = JSON.stringify([{ name: 'old-package', version: '1.0' }]);
            const after = JSON.stringify([{ name: 'new-package', version: '2.0' }]);
            const reader = sinon.stub(helpers, useUv ? 'runPython' : 'runUV').resolves(before);
            sinon.stub(helpers, useUv ? 'runUV' : 'runPython').resolves(after);
            sinon.stub(backend, 'getDirectPackageNames').resolves(new Set());

            const otherCached = await peer.getPackages(otherEnvironment);
            shouldUseUv.resolves(!useUv);
            await manager.getPackages(environment);
            reader.resolves(after);

            shouldUseUv.resolves(useUv);
            await manager.refresh(environment);
            assert.strictEqual(await peer.getPackages(otherEnvironment), otherCached);

            shouldUseUv.resolves(!useUv);
            const refreshed = await manager.getPackages(environment);
            assert.deepStrictEqual(refreshed?.map((pkg) => pkg.name), ['new-package']);
            assert.strictEqual(await manager.getPackages(environment), refreshed);
            assert.strictEqual(reader.callCount, 3);
        });

        for (const direct of [false, true]) {
            for (const outcome of ['success', 'failure', 'cancellation']) {
                test(`switching back after ${direct ? 'direct' : 'routed'} ${useUv ? 'uv' : 'pip'} ${outcome} reloads inventory`, async () => {
                    sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
                    const before = JSON.stringify([{ name: 'old-package', version: '1.0' }]);
                    const after = JSON.stringify([{ name: 'new-package', version: '2.0' }]);
                    const reader = sinon.stub(helpers, useUv ? 'runPython' : 'runUV').resolves(before);
                    const writer = sinon.stub(helpers, useUv ? 'runUV' : 'runPython').resolves(after);
                    shouldUseUv.resolves(!useUv);
                    await manager.getPackages(environment);
                    reader.resolves(after);
                    const error = outcome === 'cancellation' ? new CancellationError() : new Error('Install failed');
                    if (outcome !== 'success') {
                        writer.onSecondCall().rejects(error);
                    }
                    shouldUseUv.resolves(useUv);
                    const mutation = (direct ? (useUv ? uv : pip) : manager).manage(
                        environment,
                        { uninstall: ['old-package'], install: ['new-package'], runHeadless: true },
                        source.token,
                    );
                    if (outcome === 'success') {
                        await mutation;
                    } else {
                        await assert.rejects(mutation, (actual: unknown) => actual === error);
                    }
                    shouldUseUv.resolves(!useUv);
                    const packages = await manager.getPackages(environment);
                    assert.deepStrictEqual(packages?.map((pkg) => pkg.name), ['new-package']);
                    assert.strictEqual(await manager.getPackages(environment), packages);
                    assert.strictEqual(reader.callCount, 2);
                });
            }
        }

        for (const refresh of [false, true]) {
            test(`${useUv ? 'uv' : 'pip'} mutations prevent older ${refresh ? 'refreshes' : 'reads'} from restoring the peer cache`, async () => {
                sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
                const peer = useUv ? pip : uv;
                const backend = useUv ? uv : pip;
                const started = createDeferred<void>();
                const pending = createDeferred<string>();
                const run = sinon
                    .stub(helpers, useUv ? 'runPython' : 'runUV')
                    .resolves(JSON.stringify([{ name: 'new-package', version: '2.0' }]));
                run.onFirstCall().callsFake(() => {
                    started.resolve();
                    return pending.promise;
                });
                sinon.stub(helpers, useUv ? 'runUV' : 'runPython').resolves('[]');
                sinon.stub(peer, 'getDirectPackageNames').resolves(new Set());
                sinon
                    .stub(windowApis, 'withProgress')
                    .callsFake(async (_options, task) => task({ report: () => undefined }, source.token));
                const changes = sinon.spy();
                const subscription = peer.onDidChangePackages(changes);
                try {
                    const read = refresh ? peer.refresh(environment) : peer.getPackages(environment);
                    await started.promise;
                    await backend.manage(environment, { install: ['new-package'], runHeadless: true }, source.token);
                    pending.resolve(JSON.stringify([{ name: 'old-package', version: '1.0' }]));
                    await read;

                    assert.ok(changes.notCalled);
                    const packages = await peer.getPackages(environment);
                    assert.deepStrictEqual(packages?.map((pkg) => pkg.name), ['new-package']);
                    assert.strictEqual(run.callCount, 2);
                } finally {
                    subscription.dispose();
                }
            });
        }

        for (const failure of ['install', 'cancellation', 'refresh']) {
            test(`${useUv ? 'uv' : 'pip'} invalidates inventory after ${failure} following an uninstall`, async () => {
                const backend = useUv ? uv : pip;
                if (useUv) {
                    sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
                }
                const before = [{ name: 'old-package', version: '1.0', displayName: 'old-package', description: '1.0' }];
                const after = [{ name: 'remaining-package', version: '2.0', displayName: 'remaining-package', description: '2.0' }];
                const run = sinon.stub(helpers, useUv ? 'runUV' : 'runPython').resolves(JSON.stringify(after));
                run.onFirstCall().resolves(JSON.stringify(before));
                const error = failure === 'cancellation' ? new CancellationError() : new Error(`${failure} failed`);
                run.onCall(failure === 'refresh' ? 3 : 2).callsFake(async () => {
                    if (failure === 'cancellation') {
                        source.cancel();
                    }
                    throw error;
                });
                const changes = sinon.spy();
                backend.onDidChangePackages(changes);
                assert.deepStrictEqual(await backend.getPackages(environment), before);

                await assert.rejects(
                    backend.manage(
                        environment,
                        { uninstall: ['old-package'], install: ['new-package'], runHeadless: true },
                        source.token,
                    ),
                    (actual: unknown) => actual === error,
                );

                assert.deepStrictEqual(await backend.getPackages(environment), after);
                assert.strictEqual(run.callCount, failure === 'refresh' ? 5 : 4);
                assert.ok(changes.notCalled);
            });
        }

        test(`preserves baseline removal events when switching to ${useUv ? 'uv' : 'pip'} and retains the refreshed snapshot`, async () => {
            sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
            const pipPkg = { name: 'pip', version: '25.0', displayName: 'pip', description: '25.0' };
            const requestsPkg = { name: 'requests', version: '2.32.5', displayName: 'requests', description: '2.32.5' };
            const before = [pipPkg, requestsPkg];
            const after = [pipPkg];
            sinon.stub(helpers, useUv ? 'runPython' : 'runUV').resolves(JSON.stringify(before));
            const writer = sinon.stub(helpers, useUv ? 'runUV' : 'runPython').resolves(JSON.stringify(after));
            const owner = useUv ? uv : manager;
            const changes = sinon.spy();
            const subscription = owner.onDidChangePackages(changes);
            try {
                shouldUseUv.resolves(!useUv);
                await manager.getPackages(environment);

                shouldUseUv.resolves(useUv);
                await manager.manage(environment, { uninstall: ['requests'], runHeadless: true }, source.token, scope);

                assert.deepStrictEqual(await manager.getPackages(environment), after);
                assert.strictEqual(writer.callCount, 2);
                assert.strictEqual(createPackageItem.lastCall.args[2], owner);
                assert.ok(changes.calledOnce);
                assert.strictEqual(changes.firstCall.args[0].manager, owner);
                assert.strictEqual(changes.firstCall.args[0].environment, environment);
                assert.deepStrictEqual(changes.firstCall.args[0].changes, [
                    { kind: PackageChangeKind.remove, pkg: requestsPkg },
                ]);
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
                [pipManage, uvManage],
                [pipRefresh, uvRefresh],
                [pipList, uvList],
                [pipVersion, uvVersion],
                [pipVersions, uvVersions],
                [pipDirect, uvDirect],
            ]) {
                assert.strictEqual(pipCall.callCount, useUv ? 0 : 1);
                assert.strictEqual(uvCall.callCount, useUv ? 1 : 0);
            }
            assert.ok((useUv ? uvManage : pipManage).calledOnceWithExactly(environment, options, source.token, scope));
            assert.ok(
                shouldUseUv.firstCall.calledWithExactly(
                    pip.log,
                    environment.environmentPath.fsPath,
                    environment.environmentPath.fsPath,
                    source.token,
                ),
            );
        });
    }

    test('headless no-ops preserve both backend caches', async () => {
        sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
        const otherEnvironment = createMockPythonEnvironment({
            envPath: path.join(scope.fsPath, 'uv-venv'),
            version: '3.12.0',
            id: 'uv-environment',
        });
        const runPython = sinon.stub(helpers, 'runPython').resolves('[]');
        const runUV = sinon.stub(helpers, 'runUV').resolves('[]');
        const pipPackages = await pip.getPackages(environment);
        const uvPackages = await uv.getPackages(otherEnvironment);

        await pip.manage(environment, { install: [], runHeadless: true }, source.token);
        await uv.manage(otherEnvironment, { install: [], runHeadless: true }, source.token);
        await pip.manage(otherEnvironment, { install: [], runHeadless: true }, source.token);
        await uv.manage(environment, { install: [], runHeadless: true }, source.token);

        assert.strictEqual(await pip.getPackages(environment), pipPackages);
        assert.strictEqual(await uv.getPackages(otherEnvironment), uvPackages);
        assert.ok(runPython.calledOnce && runUV.calledOnce);
    });

    test('disposing the router removes cross-backend cache subscriptions', async () => {
        sinon.stub(helpers, 'getUvExecutable').resolves('test-uv');
        sinon.stub(helpers, 'runUV').resolves('[]');
        const invalidate = sinon.spy(pip, 'invalidateCache');
        manager.dispose();

        await uv.manage(environment, { install: ['requests'], runHeadless: true }, source.token);

        assert.ok(invalidate.notCalled);
    });

    test('uses uv version lookup without querying the environment pip', async () => {
        const executable = sinon.stub(helpers, 'getUvExecutable').resolves('workspace-uv');
        const runPython = sinon.stub(helpers, 'runPython');
        const runUV = sinon.stub(helpers, 'runUV').resolves(JSON.stringify({ versions: ['2.31.0', '2.32.5'] }));

        const versions = await manager.getPackageAvailableVersions(environment, 'requests');

        assert.ok(runPython.notCalled);
        assert.ok(
            shouldUseUv.calledOnceWithExactly(
                pip.log,
                environment.environmentPath.fsPath,
                environment.environmentPath.fsPath,
                undefined,
            ),
        );
        assert.ok(executable.calledOnceWithExactly(pip.log, environment.environmentPath.fsPath, undefined));
        assert.strictEqual(runUV.firstCall.args[5], 'workspace-uv');
        assert.deepStrictEqual(
            versions.map((version) => version.public),
            ['2.32.5', '2.31.0'],
        );
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
        assert.strictEqual(
            (await manager.capabilities[PackageCapability.List]({ environment: unsupported })).supported,
            false,
        );
        shouldUseUv.resolves(false);
        assert.strictEqual(
            (await manager.capabilities[PackageCapability.List]({ environment: unsupported })).supported,
            true,
        );
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
            manager[pythonToolSupport].getPackages(environment, source.token, scope),
            CancellationError,
        );
        assert.ok(shouldUseUv.notCalled);
    });

    test('probe errors propagate instead of silently falling back', async () => {
        const error = new Error('uv probe failed');
        shouldUseUv.rejects(error);
        await assert.rejects(manager.getPackages(environment), (actual: unknown) => actual === error);
    });
});
