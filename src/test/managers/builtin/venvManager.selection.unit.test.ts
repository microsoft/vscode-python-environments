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
import * as windowApis from '../../../common/window.apis';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('VenvManager - project selection recovery', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: CancellationTokenSource;

    setup(() => {
        sandbox = sinon.createSandbox();
        cancellation = new CancellationTokenSource();
        sandbox.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => {} }, cancellation.token),
        );
        sandbox.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
        cancellation.dispose();
    });

    for (const operation of ['initialize', 'refresh'] as const) {
        for (const brokenIndex of [0, 1]) {
            test(`${operation} restores other projects when saved selection ${brokenIndex + 1} cannot resolve`, async () => {
                const projects: PythonProject[] = ['a', 'b', 'c'].map((name) => ({
                    name,
                    uri: Uri.file(path.resolve('selection-recovery', `project-${name}`)),
                }));
                const environments = projects.map((project) =>
                    createMockPythonEnvironment({
                        name: project.name,
                        envPath: path.resolve(
                            'selection-recovery',
                            `external-${project.name}`,
                            process.platform === 'win32' ? 'Scripts' : 'bin',
                            'python',
                        ),
                        managerId: VENV_MANAGER_ID,
                    }),
                );
                const fallback = createMockPythonEnvironment({
                    name: 'global',
                    envPath: path.resolve('selection-recovery', 'global', 'python'),
                });
                const api = typemoq.Mock.ofType<PythonEnvironmentApi>();
                api.setup((a) => a.getPythonProjects()).returns(() => projects);
                api.setup((a) => a.getPythonProject(typemoq.It.isAny())).returns((uri: Uri) =>
                    projects.find((project) => project.uri.fsPath === uri.fsPath),
                );
                const baseManager = typemoq.Mock.ofType<EnvironmentManager>();
                baseManager.setup((m) => m.getEnvironments('global')).returns(async () => [fallback]);
                const log = typemoq.Mock.ofType<LogOutputChannel>();
                const manager = new VenvManager(
                    typemoq.Mock.ofType<NativePythonFinder>().object,
                    api.object,
                    baseManager.object,
                    log.object,
                );
                sandbox.stub(venvUtils, 'findVirtualEnvironments').callsFake(async () => []);
                sandbox.stub(venvUtils, 'getVenvForWorkspace').callsFake(async (fsPath) => {
                    const index = projects.findIndex((project) => project.uri.fsPath === fsPath);
                    return environments[index]?.environmentPath.fsPath;
                });
                const resolve = sandbox
                    .stub(venvUtils, 'resolveVenvPythonEnvironmentPath')
                    .callsFake(async (fsPath) => environments.find((env) => env.environmentPath.fsPath === fsPath));
                const events: DidChangeEnvironmentEventArgs[] = [];
                const subscription = manager.onDidChangeEnvironment((event) => events.push(event));
                try {
                    if (operation === 'refresh') {
                        await manager.initialize();
                        for (const [index, project] of projects.entries()) {
                            assert.strictEqual(await manager.get(project.uri), environments[index]);
                        }
                        events.length = 0;
                    }

                    const brokenPath = environments[brokenIndex].environmentPath.fsPath;
                    resolve.withArgs(brokenPath).resolves(undefined);
                    if (operation === 'initialize') {
                        await manager.initialize();
                    } else {
                        await manager.refresh(undefined);
                    }

                    for (const [index, project] of projects.entries()) {
                        if (index !== brokenIndex) {
                            assert.strictEqual(
                                (await manager.get(project.uri))?.environmentPath.fsPath,
                                environments[index].environmentPath.fsPath,
                                `Project ${project.name} must retain its selected interpreter`,
                            );
                        }
                    }
                    assert.deepStrictEqual(
                        events.map((event) => event.uri?.fsPath),
                        projects.filter((_, index) => index !== brokenIndex).map((project) => project.uri.fsPath),
                        'Healthy projects must still publish their restored selections',
                    );
                    log.verify(
                        (l) => l.error(`Failed to resolve python environment: ${brokenPath}`),
                        typemoq.Times.once(),
                    );
                } finally {
                    subscription.dispose();
                }
            });
        }
    }
});
