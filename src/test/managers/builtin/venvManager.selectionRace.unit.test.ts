// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typemoq from 'typemoq';
import { CancellationTokenSource, LogOutputChannel, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    EnvironmentManager,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import { VENV_MANAGER_ID } from '../../../common/constants';
import { createDeferred } from '../../../common/utils/deferred';
import * as windowApis from '../../../common/window.apis';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('VenvManager - selection during refresh', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: CancellationTokenSource;

    setup(() => {
        sandbox = sinon.createSandbox();
        cancellation = new CancellationTokenSource();
        sandbox.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => { } }, cancellation.token),
        );
        sandbox.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
        cancellation.dispose();
    });

    for (const batch of [false, true]) {
        for (const clear of [false, true]) {
            for (const stage of ['discovery', 'global lookup', 'persisted selection', 'resolution', 'later project']) {
                test(`preserves ${batch ? 'batch' : 'single'} ${clear ? 'clear' : 'selection'} during ${stage}`, async () => {
                    const project: PythonProject = {
                        name: 'project',
                        uri: Uri.file(path.resolve('selection-race', 'project')),
                    };
                    const peer: PythonProject = {
                        name: 'peer',
                        uri: Uri.file(path.resolve('selection-race', 'peer')),
                    };
                    const [oldEnv, selectedEnv, peerEnv] = ['old', 'selected', 'peer-env'].map((name) =>
                        createMockPythonEnvironment({
                            name,
                            envPath: path.resolve('selection-race', name, 'python'),
                            managerId: VENV_MANAGER_ID,
                        }),
                    );
                    const resolving = createDeferred<void>();
                    const release = createDeferred<void>();
                    let pauseAt: string | undefined;
                    const pause = async () => {
                        resolving.resolve();
                        await release.promise;
                    };
                    sandbox.stub(venvUtils, 'findVirtualEnvironments').callsFake(async () => {
                        if (pauseAt === 'discovery') {
                            await pause();
                        }
                        return [];
                    });
                    const api = typemoq.Mock.ofType<PythonEnvironmentApi>();
                    api.setup((a) => a.getPythonProjects()).returns(() => [project, peer]);
                    api.setup((a) => a.getPythonProject(typemoq.It.isAny())).returns((uri: Uri) =>
                        [project, peer].find((p) => p.uri.fsPath === uri.fsPath),
                    );
                    const base = typemoq.Mock.ofType<EnvironmentManager>();
                    base.setup((m) => m.getEnvironments('global')).returns(async () => {
                        if (pauseAt === 'global lookup') {
                            await pause();
                        }
                        return [];
                    });
                    const manager = new VenvManager(
                        typemoq.Mock.ofType<NativePythonFinder>().object,
                        api.object,
                        base.object,
                        typemoq.Mock.ofType<LogOutputChannel>().object,
                    );
                    const persisted = new Map<string, string | undefined>([
                        [project.uri.fsPath, oldEnv.environmentPath.fsPath],
                        [peer.uri.fsPath, peerEnv.environmentPath.fsPath],
                    ]);
                    sandbox.stub(venvUtils, 'getVenvForWorkspace').callsFake(async (scope) => {
                        const value = persisted.get(scope);
                        if (pauseAt === 'persisted selection' && scope === project.uri.fsPath) {
                            await pause();
                        }
                        return value;
                    });
                    sandbox.stub(venvUtils, 'setVenvForWorkspace').callsFake(async (scope, envPath) => {
                        persisted.set(scope, envPath);
                    });
                    sandbox.stub(venvUtils, 'setVenvForWorkspaces').callsFake(async (scopes, envPath) => {
                        scopes.forEach((scope) => persisted.set(scope, envPath));
                    });
                    sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').callsFake(async (envPath) => {
                        if (
                            (pauseAt === 'resolution' && envPath === oldEnv.environmentPath.fsPath) ||
                            (pauseAt === 'later project' && envPath === peerEnv.environmentPath.fsPath)
                        ) {
                            await pause();
                        }
                        return [oldEnv, selectedEnv, peerEnv].find((env) => env.environmentPath.fsPath === envPath);
                    });
                    await manager.initialize();
                    assert.strictEqual(await manager.get(project.uri), oldEnv);
                    assert.strictEqual(await manager.get(peer.uri), peerEnv);
                    pauseAt = stage;
                    const events: DidChangeEnvironmentEventArgs[] = [];
                    const subscription = manager.onDidChangeEnvironment((event) => events.push(event));
                    const refresh = manager.refresh(undefined);
                    try {
                        await resolving.promise;
                        const expected = clear ? undefined : selectedEnv;
                        await manager.set(batch ? [project.uri] : project.uri, expected);
                        assert.strictEqual(await manager.get(project.uri), expected);
                        events.length = 0;
                        release.resolve();
                        await refresh;

                        assert.strictEqual(persisted.get(project.uri.fsPath), expected?.environmentPath.fsPath);
                        assert.strictEqual(
                            (await manager.get(project.uri))?.environmentPath.fsPath,
                            expected?.environmentPath.fsPath,
                            'Completing an older refresh must not restore the previous interpreter',
                        );
                        assert.deepStrictEqual(
                            events.filter((event) => event.uri?.fsPath === project.uri.fsPath),
                            [],
                            'An older refresh must not publish a stale selection event',
                        );
                        assert.strictEqual(await manager.get(peer.uri), peerEnv, 'Other projects must still be restored');
                        pauseAt = undefined;
                        await manager.refresh(undefined);
                        assert.strictEqual(await manager.get(project.uri), expected, 'Later refreshes must still restore selections');
                    } finally {
                        release.resolve();
                        await refresh;
                        subscription.dispose();
                    }
                });
            }
        }
    }
});
