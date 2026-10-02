// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typemoq from 'typemoq';
import { CancellationTokenSource, LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironmentApi, PythonProject } from '../../../api';
import * as telemetry from '../../../common/telemetry/sender';
import { isSameOrParentPath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as sourcing from '../../../managers/conda/condaSourcingUtils';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { makeMockCondaEnvironment } from '../../mocks/pythonEnvironment';

suite('CondaEnvManager - project isolation', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: CancellationTokenSource;

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
        for (const scenario of [
            'no-base',
            'base',
            'two-local',
            'explicit-shared',
            'explicit-external',
            'nested-parent',
            'nested-child',
        ] as const) {
            for (const ownerFirst of [false, true]) {
                test(`${operation}: project selections remain isolated (${scenario}, ownerFirst=${ownerFirst})`, async () => {
                    const hasBase = scenario !== 'no-base';
                    const owner: PythonProject = {
                        name: 'owner',
                        uri: Uri.file(
                            scenario === 'nested-parent'
                                ? path.resolve('conda-isolation', 'project-a', 'nested')
                                : path.resolve('conda-isolation', 'project-a'),
                        ),
                    };
                    const other: PythonProject = {
                        name: 'other',
                        uri: Uri.file(
                            scenario === 'nested-parent'
                                ? path.resolve('conda-isolation', 'project-a')
                                : scenario === 'nested-child'
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
                    const refresh = sandbox.stub(condaUtils, 'refreshCondaEnvs').resolves(hasBase ? [base] : []);
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
                            assert.strictEqual(await manager.get(other.uri), hasBase ? base : undefined);
                        }
                        refresh.resolves([
                            ...(hasBase ? [base] : []),
                            local,
                            ...(scenario === 'two-local' ? [otherLocal] : []),
                        ]);
                        const explicit =
                            scenario === 'explicit-shared'
                                ? local
                                : scenario === 'explicit-external'
                                  ? external
                                  : undefined;
                        savedSelection.withArgs(other.uri.fsPath).resolves(explicit?.environmentPath.fsPath);
                        const expectedOther =
                            explicit ?? (scenario === 'two-local' ? otherLocal : hasBase ? base : undefined);
                        if (operation === 'initialize') {
                            await manager.initialize();
                        } else {
                            await manager.refresh(undefined);
                        }

                        assert.strictEqual(await manager.get(owner.uri), local);
                        assert.strictEqual(
                            await manager.get(other.uri),
                            expectedOther,
                            "Only an explicit selection may make a project use another project's local environment",
                        );
                        assert.strictEqual(
                            await manager.get(Uri.joinPath(other.uri, 'main.py')),
                            expectedOther,
                            "Files in the other project must use that project's selected environment or fallback",
                        );
                        if (scenario === 'explicit-external') {
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
});
