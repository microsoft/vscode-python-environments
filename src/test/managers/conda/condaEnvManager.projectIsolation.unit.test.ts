// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typemoq from 'typemoq';
import { CancellationTokenSource, LogOutputChannel, Uri, WorkspaceConfiguration } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../../api';
import * as telemetry from '../../../common/telemetry/sender';
import { isSameOrParentPath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { PythonProjectManagerImpl } from '../../../features/projectManager';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as sourcing from '../../../managers/conda/condaSourcingUtils';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { makeMockCondaEnvironment } from '../../mocks/pythonEnvironment';

interface IsolationScenario {
    name: string;
    hasBase: boolean;
    otherLocal?: boolean;
    explicit?: 'shared' | 'external';
    nesting?: 'owner-is-child' | 'other-is-child';
    reverseProjectOrder?: boolean;
}

const scenarios: IsolationScenario[] = [
    { name: 'no-base', hasBase: false },
    { name: 'base', hasBase: true, reverseProjectOrder: true },
    { name: 'two-local', hasBase: true, otherLocal: true },
    { name: 'explicit-shared', hasBase: true, explicit: 'shared' },
    { name: 'explicit-external', hasBase: true, explicit: 'external', reverseProjectOrder: true },
    { name: 'nested-parent', hasBase: true, nesting: 'owner-is-child' },
    { name: 'nested-child', hasBase: true, nesting: 'other-is-child' },
];

suite('CondaEnvManager - project isolation', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: CancellationTokenSource;

    function assertEnvironment(
        actual: PythonEnvironment | undefined,
        expected: PythonEnvironment | undefined,
        message?: string,
    ): void {
        assert.strictEqual(actual?.envId.id, expected?.envId.id, message);
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        cancellation = new CancellationTokenSource();
        const condaPath = path.resolve('conda-isolation', 'conda');
        sandbox.stub(condaUtils, 'getConda').resolves(condaPath);
        sandbox.stub(condaUtils, 'getCondaPathSetting').returns(undefined);
        sandbox.stub(condaUtils, 'getCondaForGlobal').resolves(undefined);
        sandbox
            .stub(sourcing, 'constructCondaSourcingStatus')
            .resolves(new sourcing.CondaSourcingStatus(condaPath, path.dirname(condaPath)));
        sandbox.stub(telemetry, 'sendTelemetryEvent');
        sandbox
            .stub(windowApis, 'withProgress')
            .callsFake(async (_options, task) => task({ report: () => {} }, cancellation.token));
    });

    teardown(() => {
        sandbox.restore();
        cancellation.dispose();
    });

    for (const operation of ['initialize', 'refresh'] as const) {
        for (const scenario of scenarios) {
            const projectOrders = scenario.reverseProjectOrder ? [false, true] : [false];
            for (const ownerFirst of projectOrders) {
                test(`${operation}: project selections remain isolated (${scenario.name}, ownerFirst=${ownerFirst})`, async () => {
                    const owner: PythonProject = {
                        name: 'owner',
                        uri: Uri.file(
                            scenario.nesting === 'owner-is-child'
                                ? path.resolve('conda-isolation', 'project-a', 'nested')
                                : path.resolve('conda-isolation', 'project-a'),
                        ),
                    };
                    const other: PythonProject = {
                        name: 'other',
                        uri: Uri.file(
                            scenario.nesting === 'owner-is-child'
                                ? path.resolve('conda-isolation', 'project-a')
                                : scenario.nesting === 'other-is-child'
                                  ? path.resolve('conda-isolation', 'project-a', 'nested')
                                  : path.resolve('conda-isolation', 'project-b'),
                        ),
                    };
                    const projects = ownerFirst ? [owner, other] : [other, owner];
                    const projectsBySpecificity = [...projects].sort(
                        (a, b) => b.uri.fsPath.length - a.uri.fsPath.length,
                    );
                    const local = makeMockCondaEnvironment('project-env', Uri.joinPath(owner.uri, '.conda').fsPath);
                    const base = makeMockCondaEnvironment('base', path.resolve('conda-isolation', 'base'));
                    const otherLocal = makeMockCondaEnvironment(
                        'other-project-env',
                        Uri.joinPath(other.uri, '.conda').fsPath,
                    );
                    const external = makeMockCondaEnvironment('external', path.resolve('conda-isolation', 'external'));
                    const api = typemoq.Mock.ofType<PythonEnvironmentApi>();
                    api.setup((a) => a.getPythonProjects()).returns(() => projects);
                    api.setup((a) => a.getPythonProject(typemoq.It.isAny())).returns((uri: Uri) =>
                        projectsBySpecificity.find((project) => isSameOrParentPath(project.uri.fsPath, uri.fsPath)),
                    );
                    const refresh = sandbox
                        .stub(condaUtils, 'refreshCondaEnvs')
                        .resolves(scenario.hasBase ? [base] : []);
                    const savedSelection = sandbox.stub(condaUtils, 'getCondaForWorkspace').resolves(undefined);
                    const resolve = sandbox.stub(condaUtils, 'resolveCondaPath').resolves(external);
                    const manager = new CondaEnvManager(
                        typemoq.Mock.ofType<NativePythonFinder>().object,
                        api.object,
                        typemoq.Mock.ofType<LogOutputChannel>().object,
                    );
                    try {
                        if (operation === 'refresh') {
                            await manager.initialize();
                            assertEnvironment(await manager.get(other.uri), scenario.hasBase ? base : undefined);
                        }
                        refresh.resolves([
                            ...(scenario.hasBase ? [base] : []),
                            local,
                            ...(scenario.otherLocal ? [otherLocal] : []),
                        ]);
                        const explicit =
                            scenario.explicit === 'shared'
                                ? local
                                : scenario.explicit === 'external'
                                  ? external
                                  : undefined;
                        savedSelection.withArgs(other.uri.fsPath).resolves(explicit?.environmentPath.fsPath);
                        const expectedOther =
                            explicit ?? (scenario.otherLocal ? otherLocal : scenario.hasBase ? base : undefined);
                        if (operation === 'initialize') {
                            await manager.initialize();
                        } else {
                            await manager.refresh(undefined);
                        }

                        assertEnvironment(await manager.get(owner.uri), local);
                        assertEnvironment(
                            await manager.get(other.uri),
                            expectedOther,
                            "Only an explicit selection may make a project use another project's local environment",
                        );
                        assertEnvironment(
                            await manager.get(Uri.joinPath(other.uri, 'main.py')),
                            expectedOther,
                            "Files in the other project must use that project's selected environment or fallback",
                        );
                        if (scenario.explicit === 'external') {
                            sinon.assert.calledOnce(resolve);
                            assert.strictEqual(resolve.firstCall.args[0], external.environmentPath.fsPath);
                        } else {
                            sinon.assert.notCalled(resolve);
                        }
                    } finally {
                        manager.dispose();
                    }
                });
            }
        }
    }

    test('uses the real project manager to isolate nested project environments', async () => {
        sandbox.stub(workspaceApis, 'getConfiguration').returns({
            get: <T>(_key: string, defaultValue?: T) => defaultValue,
        } as WorkspaceConfiguration);
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);

        const projects = new PythonProjectManagerImpl();
        const parent = projects.create('parent', Uri.file(path.resolve('conda-isolation', 'project-a')));
        const child = projects.create('child', Uri.joinPath(parent.uri, 'nested'));
        await projects.add([parent, child], { persistSettings: false });

        const base = makeMockCondaEnvironment('base', path.resolve('conda-isolation', 'base'));
        const childLocal = makeMockCondaEnvironment('child-env', Uri.joinPath(child.uri, '.conda').fsPath);
        sandbox.stub(condaUtils, 'refreshCondaEnvs').resolves([base, childLocal]);
        sandbox.stub(condaUtils, 'getCondaForWorkspace').resolves(undefined);
        const api = {
            getPythonProjects: () => projects.getProjects(),
            getPythonProject: (uri: Uri) => projects.get(uri),
        } as unknown as PythonEnvironmentApi;
        const manager = new CondaEnvManager(
            typemoq.Mock.ofType<NativePythonFinder>().object,
            api,
            typemoq.Mock.ofType<LogOutputChannel>().object,
        );

        try {
            await manager.initialize();

            assertEnvironment(await manager.get(parent.uri), base);
            assertEnvironment(await manager.get(Uri.joinPath(parent.uri, 'main.py')), base);
            assertEnvironment(await manager.get(child.uri), childLocal);
            assertEnvironment(await manager.get(Uri.joinPath(child.uri, 'main.py')), childLocal);
        } finally {
            manager.dispose();
            projects.dispose();
        }
    });
});
