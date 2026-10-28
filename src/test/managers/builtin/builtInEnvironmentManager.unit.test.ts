// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import { DEFAULT_PACKAGE_MANAGER_ID } from '../../../common/constants';
import * as persistentState from '../../../common/persistentState';
import * as windowApis from '../../../common/window.apis';
import * as envCommands from '../../../features/envCommands';
import { BuiltInEnvironmentManager } from '../../../managers/builtin/builtInEnvironmentManager';
import * as helpers from '../../../managers/builtin/helpers';
import * as builtinUtils from '../../../managers/builtin/utils';
import { UV_ENVS_KEY } from '../../../managers/builtin/uvEnvironments';
import { UvEnvironmentManager } from '../../../managers/builtin/uvEnvironmentManager';
import {
    VENV_GLOBAL_KEY,
    VENV_WORKSPACE_KEY,
    VenvEnvironmentManager,
} from '../../../managers/builtin/venvEnvironmentManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import {
    EnvironmentCreationOptions,
    selectEnvironmentBackend,
} from '../../../managers/builtin/venvUtils';
import {
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../../../managers/common/nativePythonFinder';
import * as managerUtils from '../../../managers/common/utils';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('BuiltInEnvironmentManager and peer backends', () => {
    const root = Uri.file(path.resolve('workspace with spaces'));
    const destination = path.join(root.fsPath, '.venv');
    const executable = path.join(root.fsPath, 'base', 'python');
    const uvExecutable = path.join(root.fsPath, '.pyprojectx', 'main', 'uv');
    const base = createMockPythonEnvironment({ envPath: executable, version: '3.12.0' });
    let source: CancellationTokenSource;

    function creationOptions(toolExecution = false): EnvironmentCreationOptions {
        return {
            executable,
            environmentPath: destination,
            cwd: root.fsPath,
            log: createMockLogOutputChannel(),
            token: source.token,
            timeout: toolExecution ? 300_000 : undefined,
            toolExecution,
        };
    }

    setup(() => {
        source = new CancellationTokenSource();
    });

    teardown(() => {
        source.dispose();
        sinon.restore();
    });

    for (const toolExecution of [false, true]) {
        test(`standard backend uses only python -m venv (tool execution: ${toolExecution})`, async () => {
            const runPython = sinon.stub(helpers, 'runPython').resolves('');
            const runUv = sinon.stub(helpers, 'runUV').resolves('');
            const uvProbe = sinon.stub(helpers, 'getUvExecutable').resolves(uvExecutable);
            const options = creationOptions(toolExecution);
            const { log } = options;

            await new VenvEnvironmentManager().create(options);

            sinon.assert.calledOnceWithExactly(
                runPython,
                executable,
                ['-m', 'venv', destination],
                root.fsPath,
                log,
                source.token,
                toolExecution ? 300_000 : undefined,
                toolExecution,
            );
            sinon.assert.notCalled(runUv);
            sinon.assert.notCalled(uvProbe);
        });

        test(`uv backend resolves scoped uv and preserves command flags (tool execution: ${toolExecution})`, async () => {
            const runPython = sinon.stub(helpers, 'runPython').resolves('');
            const runUv = sinon.stub(helpers, 'runUV').resolves('');
            const uvProbe = sinon.stub(helpers, 'getUvExecutable').resolves(uvExecutable);
            const options = creationOptions(toolExecution);
            const { log } = options;

            await new UvEnvironmentManager().create(options);

            sinon.assert.calledOnceWithExactly(uvProbe, log, root.fsPath, source.token);
            sinon.assert.calledOnceWithExactly(
                runUv,
                ['venv', '--verbose', '--seed', '--python', executable, destination],
                root.fsPath,
                log,
                source.token,
                toolExecution ? 300_000 : undefined,
                uvExecutable,
                toolExecution,
            );
            sinon.assert.notCalled(runPython);
        });
    }

    for (const useUv of [false, true]) {
        test(`central routing returns the injected ${useUv ? 'uv' : 'venv'} peer`, async () => {
            const policy = sinon.stub(helpers, 'shouldUseUv').resolves(useUv);
            const log = createMockLogOutputChannel();
            const venv = new VenvEnvironmentManager();
            const uv = new UvEnvironmentManager();

            const selected = await selectEnvironmentBackend(log, base, root, source.token, venv, uv);

            assert.strictEqual(selected, useUv ? uv : venv);
            sinon.assert.calledOnceWithExactly(policy, log, base.environmentPath.fsPath, root.fsPath, source.token);
        });

        test(`facade routes custom creation through its injected ${useUv ? 'uv' : 'venv'} peer`, async () => {
            sinon.stub(helpers, 'shouldUseUv').resolves(useUv);
            sinon.stub(envCommands, 'findParentIfFile').resolves(root.fsPath);
            const log = createMockLogOutputChannel();
            const venv = new VenvEnvironmentManager();
            const uv = new UvEnvironmentManager();
            const api = { getEnvironments: sinon.stub().resolves([base]) } as unknown as PythonEnvironmentApi;
            const facade = new BuiltInEnvironmentManager(
                {} as NativePythonFinder,
                api,
                {} as EnvironmentManager,
                log,
                venv,
                uv,
            );
            const workflow = sinon.stub(venvUtils, 'createPythonVenv').callsFake(
                async (_finder, _api, _log, owner, bases, creationRoot, options, selectBackend) => {
                    assert.strictEqual(owner, facade);
                    assert.deepStrictEqual(bases, [base]);
                    assert.deepStrictEqual(options, { showQuickAndCustomOptions: true });
                    assert.ok(selectBackend);
                    assert.strictEqual(await selectBackend(base, creationRoot, source.token), useUv ? uv : venv);
                    return undefined;
                },
            );

            await facade.create(root, undefined);

            assert.strictEqual(facade.name, 'venv');
            assert.strictEqual(facade.preferredPackageManagerId, DEFAULT_PACKAGE_MANAGER_ID);
            sinon.assert.calledOnce(workflow);
        });
    }

    test('refreshes nativeFinder once and delegates classification, descriptions, and uv tracking to peers', async () => {
        const tracked: string[] = [];
        const state = {
            get: sinon.stub().withArgs(UV_ENVS_KEY).callsFake(async () => [...tracked]),
            set: sinon.stub().callsFake(async (_key: string, values: string[]) => {
                tracked.splice(0, tracked.length, ...values);
            }),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(state);
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        sinon.stub(managerUtils, 'getShellActivationCommands').resolves({
            shellActivation: new Map(),
            shellDeactivation: new Map(),
        });
        sinon
            .stub(builtinUtils, 'isUvManagedPythonInstall')
            .callsFake(async (env) => env.prefix === path.join(root.fsPath, 'uv-python'));

        const stdVenv: NativeEnvInfo = {
            kind: NativePythonEnvironmentKind.venv,
            name: '.venv',
            prefix: path.join(root.fsPath, '.venv'),
            executable: path.join(root.fsPath, '.venv', 'bin', 'python'),
            version: '3.12.0',
        };
        const uvVenv: NativeEnvInfo = {
            kind: NativePythonEnvironmentKind.venvUv,
            name: '.uv-venv',
            prefix: path.join(root.fsPath, '.uv-venv'),
            executable: path.join(root.fsPath, '.uv-venv', 'bin', 'python'),
            version: '3.12.0',
        };
        const uvWorkspace: NativeEnvInfo = {
            kind: NativePythonEnvironmentKind.uvWorkspace,
            name: '.uv-ws',
            prefix: path.join(root.fsPath, '.uv-ws'),
            executable: path.join(root.fsPath, '.uv-ws', 'bin', 'python'),
            version: '3.12.0',
        };
        const uvBaseInstall: NativeEnvInfo = {
            kind: NativePythonEnvironmentKind.venvUv,
            name: 'cpython-3.13',
            prefix: path.join(root.fsPath, 'uv-python'),
            executable: path.join(root.fsPath, 'uv-python', 'bin', 'python'),
            version: '3.13.0',
        };
        const finder = {
            refresh: sinon.stub().resolves([stdVenv, uvVenv, uvWorkspace, uvBaseInstall]),
        } as unknown as NativePythonFinder;
        const api = {
            createPythonEnvironmentItem: sinon.stub().callsFake(
                (info: PythonEnvironmentInfo, owner: EnvironmentManager): PythonEnvironment => ({
                    ...info,
                    envId: { id: info.environmentPath.fsPath, managerId: `ms-python.python:${owner.name}` },
                }),
            ),
            getPythonProjects: () => [],
            getPythonProject: () => undefined,
        } as unknown as PythonEnvironmentApi;
        const baseManager = { getEnvironments: sinon.stub().resolves([]) } as unknown as EnvironmentManager;
        const venv = new VenvEnvironmentManager();
        const uv = new UvEnvironmentManager();
        const facade = new BuiltInEnvironmentManager(
            finder,
            api,
            baseManager,
            createMockLogOutputChannel(),
            venv,
            uv,
        );

        const discovered = await facade.getEnvironments('all');

        sinon.assert.calledOnce(finder.refresh as sinon.SinonStub);
        assert.strictEqual(discovered.length, 3);
        assert.ok(discovered.every((env) => env.envId.managerId === 'ms-python.python:venv'));
        assert.deepStrictEqual(
            new Set(discovered.map((env) => `${env.name}:${env.description ?? 'venv'}`)),
            new Set(['.venv (3.12.0):venv', '.uv-venv (3.12.0):uv', '.uv-ws (3.12.0):uv workspace']),
        );
        assert.strictEqual(state.set.callCount, 2);
        assert.deepStrictEqual(tracked, [
            Uri.file(uvVenv.executable!).fsPath,
            Uri.file(uvWorkspace.executable!).fsPath,
        ]);
    });

    test('venv and uv backends manage their own persistent cache keys and untrack on removal', async () => {
        const state = {
            get: sinon.stub().withArgs(UV_ENVS_KEY).resolves([executable]),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(state);
        const venv = new VenvEnvironmentManager();
        const uv = new UvEnvironmentManager();

        await venv.clearCache();
        sinon.assert.calledOnceWithExactly(state.clear, [VENV_WORKSPACE_KEY, VENV_GLOBAL_KEY]);

        await uv.untrackEnvironment(executable);
        sinon.assert.calledOnceWithExactly(state.set, UV_ENVS_KEY, []);

        state.set.resetHistory();
        await uv.clearCache();
        sinon.assert.calledOnceWithExactly(state.set, UV_ENVS_KEY, []);
    });

    test('uv disappearing after routing is an error, not a standard-library fallback', async () => {
        sinon.stub(helpers, 'getUvExecutable').resolves(undefined);
        const runPython = sinon.stub(helpers, 'runPython').resolves('');
        const runUv = sinon.stub(helpers, 'runUV').resolves('');

        await assert.rejects(new UvEnvironmentManager().create(creationOptions()), /uv became unavailable/);

        sinon.assert.notCalled(runPython);
        sinon.assert.notCalled(runUv);
    });

    test('command failure is propagated without retrying the other backend', async () => {
        sinon.stub(helpers, 'getUvExecutable').resolves(uvExecutable);
        const error = new Error('uv creation failed');
        sinon.stub(helpers, 'runUV').rejects(error);
        const runPython = sinon.stub(helpers, 'runPython').resolves('');

        await assert.rejects(
            new UvEnvironmentManager().create(creationOptions()),
            (actual) => actual === error,
        );
        sinon.assert.notCalled(runPython);
    });

    for (const backend of [new VenvEnvironmentManager(), new UvEnvironmentManager()]) {
        test(`${backend.usesUv ? 'uv' : 'venv'} backend rejects cancellation before probing or execution`, async () => {
            const runPython = sinon.stub(helpers, 'runPython').resolves('');
            const runUv = sinon.stub(helpers, 'runUV').resolves('');
            const uvProbe = sinon.stub(helpers, 'getUvExecutable').resolves(uvExecutable);
            source.cancel();

            await assert.rejects(backend.create(creationOptions()), CancellationError);

            sinon.assert.notCalled(runPython);
            sinon.assert.notCalled(runUv);
            sinon.assert.notCalled(uvProbe);
        });
    }
});
