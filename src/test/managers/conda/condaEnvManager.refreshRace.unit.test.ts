// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationTokenSource, LogOutputChannel, Uri } from 'vscode';
import {
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import { createDeferred, Deferred } from '../../../common/utils/deferred';
import { isSameOrParentPath, normalizePath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

type PersistedSelectionScope = 'global' | 'project';

interface CondaManagerInternals {
    _initialized: Deferred<void> | undefined;
    loadEnvMap(): Promise<void>;
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function createProject(scope: PersistedSelectionScope): PythonProject {
    return {
        name: `${scope}-project`,
        uri: Uri.file(path.resolve('conda-refresh-race', scope, 'project')),
    };
}

function createApi(project: PythonProject): PythonEnvironmentApi {
    return {
        getPythonProjects: () => [project],
        getPythonProject: (uri: Uri) =>
            isSameOrParentPath(project.uri.fsPath, uri.fsPath) ? project : undefined,
    } as unknown as PythonEnvironmentApi;
}

function createLog(): LogOutputChannel {
    return {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub(),
    } as unknown as LogOutputChannel;
}

function createEnvironment(name: string, envPath: string, version = '3.12.0'): PythonEnvironment {
    return createMockPythonEnvironment({
        name,
        envPath,
        version,
        id: `${name}-id`,
    });
}

suite('CondaEnvManager - concurrent persisted selection restoration', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: CancellationTokenSource;

    setup(() => {
        sandbox = sinon.createSandbox();
        cancellation = new CancellationTokenSource();
        sandbox.stub(fs.promises, 'access').resolves();
        sandbox.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => undefined }, cancellation.token),
        );
    });

    teardown(() => {
        sandbox.restore();
        cancellation.dispose();
    });

    for (const selectionScope of ['global', 'project'] as const) {
        test(`deduplicates concurrent ${selectionScope} persisted-path resolution and keeps its mapping canonical`, async () => {
            const project = createProject(selectionScope);
            const targetPath = Uri.file(path.resolve('conda-refresh-race', selectionScope, 'external-prefix')).fsPath;
            const persistedPath = path.join(
                targetPath,
                process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python'),
            );
            const alternateTargetPath =
                path.sep === '\\' ? targetPath.replace(/\\/g, '/') : targetPath.replace(/\//g, '\\');
            assert.notStrictEqual(alternateTargetPath, targetPath, 'The raw path spellings must differ');
            assert.strictEqual(
                normalizePath(alternateTargetPath),
                normalizePath(targetPath),
                'The competing path spellings must have the same collection identity',
            );
            const firstResolved = createEnvironment(`${selectionScope}-first`, targetPath);
            const secondResolved: PythonEnvironment = {
                ...createEnvironment(`${selectionScope}-second`, targetPath),
                environmentPath: { fsPath: alternateTargetPath } as Uri,
            };
            sandbox
                .stub(condaUtils, 'getCondaForGlobal')
                .resolves(selectionScope === 'global' ? persistedPath : undefined);
            sandbox.stub(condaUtils, 'getCondaForWorkspace').callsFake(async (fsPath) =>
                selectionScope === 'project' && fsPath === project.uri.fsPath ? persistedPath : undefined,
            );

            const firstResolutionStarted = createDeferred<void>();
            const releaseFirstResolution = createDeferred<void>();
            let resolutionCount = 0;
            let activeResolutions = 0;
            let maxActiveResolutions = 0;
            const resolveCondaPath = sandbox.stub(condaUtils, 'resolveCondaPath').callsFake(async () => {
                const currentResolution = ++resolutionCount;
                activeResolutions += 1;
                maxActiveResolutions = Math.max(maxActiveResolutions, activeResolutions);
                try {
                    if (currentResolution === 1) {
                        firstResolutionStarted.resolve();
                        await releaseFirstResolution.promise;
                        return firstResolved;
                    }
                    return secondResolved;
                } finally {
                    activeResolutions -= 1;
                }
            });

            const manager = new CondaEnvManager(
                {} as NativePythonFinder,
                createApi(project),
                createLog(),
            );
            const internals = manager as unknown as CondaManagerInternals;
            const initialized = createDeferred<void>();
            initialized.resolve();
            internals._initialized = initialized;

            const firstLoad = internals.loadEnvMap();
            await firstResolutionStarted.promise;
            const secondLoad = internals.loadEnvMap();
            await nextTurn();
            releaseFirstResolution.resolve();
            await Promise.all([firstLoad, secondLoad]);

            const environments = await manager.getEnvironments('all');
            const selected = await manager.get(selectionScope === 'global' ? undefined : project.uri);
            assert.strictEqual(maxActiveResolutions, 2, 'The harness must force both stale checks before either append');
            assert.ok(
                resolveCondaPath.getCalls().every((call) => call.args[0] === persistedPath),
                'Each persisted interpreter alias must resolve to its canonical prefix',
            );
            assert.strictEqual(environments.length, 1, 'Only one object may represent the external prefix');
            assert.strictEqual(environments[0], secondResolved, 'The first completed resolution becomes canonical');
            assert.strictEqual(selected, environments[0], 'The persisted selection must reference the collection object');
        });

        test(`serializes startup and explicit refresh for a ${selectionScope} persisted selection`, async () => {
            const project = createProject(selectionScope);
            const targetPath = Uri.file(path.resolve('conda-refresh-race', selectionScope, 'external-prefix')).fsPath;
            const fastPathEnvironment = createEnvironment(`${selectionScope}-fast`, targetPath);
            const backgroundEnvironment = createEnvironment(`${selectionScope}-background`, targetPath);
            const refreshedEnvironment = createEnvironment(`${selectionScope}-refreshed`, targetPath);
            const noPythonEnvironment = createEnvironment(`${selectionScope}-no-python`, targetPath, 'no-python');

            sandbox
                .stub(condaUtils, 'getCondaForGlobal')
                .resolves(selectionScope === 'global' ? targetPath : undefined);
            sandbox.stub(condaUtils, 'getCondaForWorkspace').callsFake(async (fsPath) =>
                selectionScope === 'project' && fsPath === project.uri.fsPath ? targetPath : undefined,
            );

            const releaseInitialDiscovery = createDeferred<PythonEnvironment[]>();
            let discoveryCount = 0;
            const refreshCondaEnvs = sandbox.stub(condaUtils, 'refreshCondaEnvs').callsFake(async () => {
                discoveryCount += 1;
                if (discoveryCount === 1) {
                    return releaseInitialDiscovery.promise;
                }
                if (discoveryCount === 2) {
                    return [];
                }
                return [noPythonEnvironment];
            });

            const firstInventoryResolutionStarted = createDeferred<void>();
            const releaseFirstInventoryResolution = createDeferred<void>();
            let resolutionCount = 0;
            let activeResolutions = 0;
            let maxActiveResolutions = 0;
            const resolveCondaPath = sandbox.stub(condaUtils, 'resolveCondaPath').callsFake(async () => {
                const currentResolution = ++resolutionCount;
                activeResolutions += 1;
                maxActiveResolutions = Math.max(maxActiveResolutions, activeResolutions);
                try {
                    if (selectionScope === 'project' && currentResolution === 1) {
                        return fastPathEnvironment;
                    }
                    const inventoryResolution = currentResolution - (selectionScope === 'project' ? 1 : 0);
                    if (inventoryResolution === 1) {
                        firstInventoryResolutionStarted.resolve();
                        await releaseFirstInventoryResolution.promise;
                        return backgroundEnvironment;
                    }
                    return refreshedEnvironment;
                } finally {
                    activeResolutions -= 1;
                }
            });

            const manager = new CondaEnvManager(
                {} as NativePythonFinder,
                createApi(project),
                createLog(),
            );
            const events: DidChangeEnvironmentsEventArgs[] = [];
            const subscription = manager.onDidChangeEnvironments((event) => events.push(event));

            try {
                const startupGet = manager.get(project.uri);
                if (selectionScope === 'project') {
                    assert.strictEqual(await startupGet, fastPathEnvironment, 'The fast path must remain immediate');
                }
                releaseInitialDiscovery.resolve([]);
                await firstInventoryResolutionStarted.promise;

                const explicitRefresh = manager.refresh(undefined);
                await nextTurn();
                releaseFirstInventoryResolution.resolve();
                await Promise.all([startupGet, explicitRefresh, manager.initialize()]);

                let environments = await manager.getEnvironments('all');
                let selected = await manager.get(selectionScope === 'global' ? undefined : project.uri);
                assert.strictEqual(maxActiveResolutions, 1, 'Inventory rebuilds must not overlap persisted resolution');
                assert.strictEqual(refreshCondaEnvs.callCount, 2, 'Both startup and explicit discovery must still run');
                assert.deepStrictEqual(environments, [refreshedEnvironment]);
                assert.strictEqual(selected, refreshedEnvironment, 'The selection must use the final collection object');
                assert.deepStrictEqual(
                    events.map((event) => event.map((change) => change.kind)),
                    [
                        [EnvironmentChangeKind.add],
                        [EnvironmentChangeKind.remove, EnvironmentChangeKind.add],
                    ],
                    'Startup and refresh must publish ordered, balanced inventory changes',
                );
                assert.strictEqual(events[0][0].environment, backgroundEnvironment);
                assert.strictEqual(events[1][0].environment, backgroundEnvironment);
                assert.strictEqual(events[1][1].environment, refreshedEnvironment);

                await manager.refresh(undefined);

                environments = await manager.getEnvironments('all');
                selected = await manager.get(selectionScope === 'global' ? undefined : project.uri);
                assert.deepStrictEqual(environments, [noPythonEnvironment]);
                assert.strictEqual(selected, noPythonEnvironment, 'A later no-Python update must not be suppressed');
                assert.strictEqual(resolveCondaPath.callCount, selectionScope === 'project' ? 3 : 2);
                assert.deepStrictEqual(
                    events[2].map((change) => change.kind),
                    [EnvironmentChangeKind.remove, EnvironmentChangeKind.add],
                    'A stable explicit refresh must retain normal remove/add event behavior',
                );
                assert.strictEqual(events[2][0].environment, refreshedEnvironment);
                assert.strictEqual(events[2][1].environment, noPythonEnvironment);
            } finally {
                releaseInitialDiscovery.resolve([]);
                releaseFirstInventoryResolution.resolve();
                subscription.dispose();
                manager.dispose();
            }
        });
    }
});
