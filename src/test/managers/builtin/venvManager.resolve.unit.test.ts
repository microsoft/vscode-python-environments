// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typemoq from 'typemoq';
import { CancellationTokenSource, LogOutputChannel, Uri } from 'vscode';
import {
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import { VENV_MANAGER_ID } from '../../../common/constants';
import * as windowApis from '../../../common/window.apis';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('VenvManager - manual path resolution', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: CancellationTokenSource;
    let manager: VenvManager;
    let project: PythonProject;
    let previous: PythonEnvironment;
    let selected: PythonEnvironment;
    let resolve: sinon.SinonStub;
    let discover: sinon.SinonStub;

    setup(async () => {
        sandbox = sinon.createSandbox();
        cancellation = new CancellationTokenSource();
        project = { name: 'project', uri: Uri.file(path.resolve('manual-selection', 'project')) };
        [previous, selected] = ['.venv-2', '.venv-1'].map((name) =>
            createMockPythonEnvironment({
                name,
                envPath: path.join(
                    project.uri.fsPath,
                    name,
                    process.platform === 'win32' ? 'Scripts' : 'bin',
                    process.platform === 'win32' ? 'python.exe' : 'python',
                ),
                managerId: VENV_MANAGER_ID,
            }),
        );
        const api = typemoq.Mock.ofType<PythonEnvironmentApi>();
        api.setup((a) => a.getPythonProjects()).returns(() => [project]);
        api.setup((a) => a.getPythonProject(typemoq.It.isAny())).returns(() => project);
        const baseManager = typemoq.Mock.ofType<EnvironmentManager>();
        baseManager.setup((m) => m.getEnvironments('global')).returns(async () => []);
        manager = new VenvManager(
            typemoq.Mock.ofType<NativePythonFinder>().object,
            api.object,
            baseManager.object,
            typemoq.Mock.ofType<LogOutputChannel>().object,
        );
        sandbox.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => {} }, cancellation.token),
        );
        sandbox.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        sandbox.stub(venvUtils, 'getVenvForWorkspace').resolves(previous.environmentPath.fsPath);
        sandbox.stub(venvUtils, 'setVenvForWorkspace').resolves();
        discover = sandbox.stub(venvUtils, 'findVirtualEnvironments').callsFake(async () => [previous]);
        resolve = sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(selected);
        await manager.initialize();
    });

    teardown(() => {
        sandbox.restore();
        cancellation.dispose();
    });

    test('publishes a manually resolved environment before selecting it without a discovery refresh', async () => {
        assert.strictEqual(await manager.get(project.uri), previous);
        const events: DidChangeEnvironmentsEventArgs[] = [];
        const subscription = manager.onDidChangeEnvironments((event) => events.push(event));
        try {
            const resolved = await manager.resolve(selected.environmentPath);

            assert.strictEqual(resolved, selected);
            assert.deepStrictEqual(await manager.getEnvironments('all'), [previous, selected]);
            assert.deepStrictEqual(events, [[{ environment: selected, kind: EnvironmentChangeKind.add }]]);

            await manager.set(project.uri, resolved);

            assert.strictEqual(await manager.get(project.uri), selected);
            assert.deepStrictEqual(await manager.getEnvironments('all'), [previous, selected]);
            sinon.assert.calledOnce(discover);
        } finally {
            subscription.dispose();
        }
    });

    test('resolving the same interpreter or its environment folder does not duplicate entries or events', async () => {
        const events: DidChangeEnvironmentsEventArgs[] = [];
        const subscription = manager.onDidChangeEnvironments((event) => events.push(event));
        try {
            await manager.resolve(selected.environmentPath);
            assert.strictEqual(await manager.resolve(selected.environmentPath), selected);
            const folder = Uri.file(path.dirname(path.dirname(selected.environmentPath.fsPath)));
            assert.strictEqual(await manager.resolve(folder), selected);

            assert.deepStrictEqual(await manager.getEnvironments('all'), [previous, selected]);
            assert.deepStrictEqual(events, [[{ environment: selected, kind: EnvironmentChangeKind.add }]]);
            sinon.assert.calledOnce(resolve);
        } finally {
            subscription.dispose();
        }
    });

    for (const result of ['unresolved', 'non-venv'] as const) {
        test(`does not add or publish ${result} interpreter results`, async () => {
            resolve.resolves(
                result === 'unresolved'
                    ? undefined
                    : createMockPythonEnvironment({
                          envPath: selected.environmentPath.fsPath,
                          managerId: 'ms-python.python:system',
                      }),
            );
            const onChanged = sandbox.spy();
            const subscription = manager.onDidChangeEnvironments(onChanged);
            try {
                assert.strictEqual(await manager.resolve(selected.environmentPath), undefined);
                assert.deepStrictEqual(await manager.getEnvironments('all'), [previous]);
                sinon.assert.notCalled(onChanged);
            } finally {
                subscription.dispose();
            }
        });
    }
});
