// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationTokenSource, Uri } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import type { PythonProjectManager } from '../../features/projectManager';
import { pythonToolSupport, ToolEnvironmentManager, waitForToolRead } from '../../internal/pythonToolSupport';
import * as cache from '../../managers/builtin/cache';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import * as systemUtils from '../../managers/builtin/utils';
import * as uvInstaller from '../../managers/builtin/uvPythonInstaller';
import { VenvManager } from '../../managers/builtin/venvManager';
import * as venvUtils from '../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import * as commonUtils from '../../managers/common/utils';
import { CondaEnvManager } from '../../managers/conda/condaEnvManager';
import * as condaUtils from '../../managers/conda/condaUtils';
import { PipenvManager } from '../../managers/pipenv/pipenvManager';
import * as pipenvUtils from '../../managers/pipenv/pipenvUtils';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import * as poetryUtils from '../../managers/poetry/poetryUtils';
import { PyEnvManager } from '../../managers/pyenv/pyenvManager';
import * as pyenvUtils from '../../managers/pyenv/pyenvUtils';
import { createMockLogOutputChannel } from '../mocks/helper';

interface TestManager extends ToolEnvironmentManager {
    initialize(): Promise<void>;
}

suite('Agent discovery isolation from public onboarding', () => {
    let source: CancellationTokenSource;
    let api: PythonEnvironmentApi;
    let entered: Deferred<void>;
    let release: Deferred<void>;
    let prompt: sinon.SinonStub;
    let notify: sinon.SinonStub;
    const finder = {} as NativePythonFinder;
    const projects = {} as PythonProjectManager;
    const scope = Uri.file(path.join(process.cwd(), 'discovery-isolation'));
    const cases: { name: string; create: () => TestManager }[] = [
        {
            name: 'system',
            create: () => new SysPythonManager(finder, api, createMockLogOutputChannel()),
        },
        {
            name: 'venv',
            create: () =>
                new VenvManager(
                    finder,
                    api,
                    new SysPythonManager(finder, api, createMockLogOutputChannel()),
                    createMockLogOutputChannel(),
                ),
        },
        {
            name: 'conda',
            create: () => new CondaEnvManager(finder, api, createMockLogOutputChannel(), projects),
        },
        { name: 'poetry', create: () => new PoetryManager(finder, api, projects) },
        { name: 'pipenv', create: () => new PipenvManager(finder, api, projects) },
        { name: 'pyenv', create: () => new PyEnvManager(finder, api, projects) },
    ];

    setup(() => {
        source = new CancellationTokenSource();
        entered = createDeferred<void>();
        release = createDeferred<void>();
        api = {
            getPythonProject: () => undefined,
            getPythonProjects: () => [],
        } as Partial<PythonEnvironmentApi> as PythonEnvironmentApi;
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: <T>(_key: string, fallback?: T) => fallback as T,
            has: () => false,
            inspect: () => undefined,
            update: async () => {},
        });
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => {} }, source.token),
        );
        const wait = () => {
            entered.resolve();
            return release.promise;
        };
        prompt = sinon.stub(uvInstaller, 'promptInstallPythonViaUv').callsFake(async () => {
            await wait();
            return undefined;
        });
        notify = sinon.stub(commonUtils, 'notifyMissingManagerIfDefault').callsFake(wait);
        sinon.stub(cache, 'getSystemEnvForGlobal').resolves(undefined);
        sinon.stub(cache, 'getSystemEnvForWorkspace').resolves(undefined);
        sinon.stub(systemUtils, 'refreshPythons').resolves([]);
        sinon.stub(systemUtils, 'resolveSystemPythonEnvironmentPath').resolves(undefined);
        sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([]);
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        sinon.stub(venvUtils, 'getVenvForWorkspace').resolves(undefined);
        sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);
        sinon.stub(condaUtils, 'getConda').rejects(new Error('Conda is not installed'));
        sinon.stub(condaUtils, 'getCondaPathSetting').returns(undefined);
        sinon.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        sinon.stub(condaUtils, 'getCondaForGlobal').resolves(undefined);
        sinon.stub(condaUtils, 'resolveCondaPath').resolves(undefined);
        sinon.stub(poetryUtils, 'getPoetry').resolves(undefined);
        sinon.stub(poetryUtils, 'refreshPoetry').resolves([]);
        sinon.stub(poetryUtils, 'getPoetryForGlobal').resolves(undefined);
        sinon.stub(poetryUtils, 'resolvePoetryPath').resolves(undefined);
        sinon.stub(pipenvUtils, 'getPipenv').resolves(undefined);
        sinon.stub(pipenvUtils, 'refreshPipenv').resolves([]);
        sinon.stub(pipenvUtils, 'getPipenvForGlobal').resolves(undefined);
        sinon.stub(pipenvUtils, 'resolvePipenvPath').resolves(undefined);
        sinon.stub(pyenvUtils, 'getPyenv').resolves(undefined);
        sinon.stub(pyenvUtils, 'refreshPyenv').resolves([]);
        sinon.stub(pyenvUtils, 'getPyenvForGlobal').resolves(undefined);
        sinon.stub(pyenvUtils, 'resolvePyenvPath').resolves(undefined);
    });

    teardown(() => {
        release.resolve();
        source.dispose();
        sinon.restore();
    });

    async function readWithoutOnboarding(manager: TestManager): Promise<void> {
        const tools = manager[pythonToolSupport];
        await waitForToolRead(tools.initialize(), source.token, 1000);
        assert.strictEqual(await waitForToolRead(tools.get(scope), source.token, 1000), undefined);
        assert.deepStrictEqual(await waitForToolRead(tools.getEnvironments('global'), source.token, 1000), []);
        assert.strictEqual(await waitForToolRead(tools.resolve(scope), source.token, 1000), undefined);
    }

    for (const scenario of cases) {
        test(`${scenario.name}: private reads do not suppress later public onboarding`, async () => {
            const manager = scenario.create();
            await readWithoutOnboarding(manager);
            assert.ok(prompt.notCalled && notify.notCalled);
            const human = manager.initialize();
            try {
                await waitForToolRead(entered.promise, source.token, 1000);
                await readWithoutOnboarding(manager);
            } finally {
                release.resolve();
                await human;
            }
            await manager.initialize();
            assert.strictEqual(prompt.callCount + notify.callCount, 1);
        });

        test(`${scenario.name}: private reads finish while public onboarding is still pending`, async () => {
            const manager = scenario.create();
            let humanFinished = false;
            const human = manager.initialize().then(() => {
                humanFinished = true;
            });
            try {
                await waitForToolRead(entered.promise, source.token, 1000);
                await readWithoutOnboarding(manager);
                assert.strictEqual(humanFinished, false);
                assert.strictEqual(prompt.callCount + notify.callCount, 1);
            } finally {
                release.resolve();
                await human;
            }
        });
    }

    test('venv private reads do not join the public fast path waiting on base Python onboarding', async () => {
        const manager = cases[1].create();
        let humanFinished = false;
        const human = manager.get(scope).then(() => {
            humanFinished = true;
        });
        try {
            await waitForToolRead(entered.promise, source.token, 1000);
            await readWithoutOnboarding(manager);
            assert.strictEqual(humanFinished, false);
        } finally {
            release.resolve();
            await human;
        }
    });
});
