// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    EnvironmentManager,
    GetEnvironmentScope,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../api';
import { createDeferred } from '../../common/utils/deferred';
import * as windowApis from '../../common/window.apis';
import * as sysCache from '../../managers/builtin/cache';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import * as sysUtils from '../../managers/builtin/utils';
import { VenvManager } from '../../managers/builtin/venvManager';
import * as venvUtils from '../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../managers/conda/condaEnvManager';
import * as condaUtils from '../../managers/conda/condaUtils';
import { PipenvManager } from '../../managers/pipenv/pipenvManager';
import * as pipenvUtils from '../../managers/pipenv/pipenvUtils';
import { PyEnvManager } from '../../managers/pyenv/pyenvManager';
import * as pyenvUtils from '../../managers/pyenv/pyenvUtils';

interface ManagerUnderTest {
    get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined>;
    initialize(): Promise<void>;
}

interface ManagerCaseContext {
    manager: ManagerUnderTest;
    getPersistedStub: sinon.SinonStub;
    resolveStub: sinon.SinonStub;
}

interface ManagerCase {
    name: string;
    managerId: string;
    persistedPath: string;
    supportsGlobalScope?: boolean;
    createContext: (sandbox: sinon.SinonSandbox) => ManagerCaseContext;
}

const testUri = Uri.file(path.resolve('test-workspace'));

function createMockEnv(managerId: string, envPath: string): PythonEnvironment {
    return {
        envId: { id: `${managerId}-env`, managerId },
        name: 'Test Env',
        displayName: 'Test Env',
        version: '3.11.0',
        displayPath: envPath,
        environmentPath: Uri.file(envPath),
        sysPrefix: envPath,
        execInfo: { run: { executable: envPath } },
    };
}

function createMockApi(projectUri?: Uri): sinon.SinonStubbedInstance<PythonEnvironmentApi> {
    const project: PythonProject | undefined = projectUri ? ({ uri: projectUri } as PythonProject) : undefined;
    return {
        getPythonProject: sinon.stub().returns(project),
        getPythonProjects: sinon.stub().returns(project ? [project] : []),
        createPythonEnvironmentItem: sinon
            .stub()
            .callsFake((_info: unknown, _mgr: unknown) => createMockEnv('test', path.resolve('resolved'))),
    } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;
}

function createMockNativeFinder(): sinon.SinonStubbedInstance<NativePythonFinder> {
    return {
        resolve: sinon.stub(),
        refresh: sinon.stub().resolves([]),
    } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;
}

function createMockLog(): sinon.SinonStubbedInstance<import('vscode').LogOutputChannel> {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
        trace: sinon.stub(),
        append: sinon.stub(),
        appendLine: sinon.stub(),
        clear: sinon.stub(),
        show: sinon.stub(),
        hide: sinon.stub(),
        dispose: sinon.stub(),
        replace: sinon.stub(),
        name: 'test-log',
        logLevel: 2,
        onDidChangeLogLevel: sinon.stub() as unknown as import('vscode').Event<import('vscode').LogLevel>,
    } as unknown as sinon.SinonStubbedInstance<import('vscode').LogOutputChannel>;
}

function stubInitialize(manager: ManagerUnderTest, sandbox: sinon.SinonSandbox): void {
    sandbox.stub(manager, 'initialize').resolves();
}

function createManagerCases(): ManagerCase[] {
    return [
        {
            name: 'VenvManager',
            managerId: 'ms-python.python:venv',
            persistedPath: path.resolve('test-workspace', '.venv'),
            createContext: (sandbox: sinon.SinonSandbox) => {
                const getPersistedStub = sandbox.stub(venvUtils, 'getVenvForWorkspace');
                const resolveStub = sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath');
                const manager = new VenvManager(
                    createMockNativeFinder(),
                    createMockApi(testUri),
                    {} as EnvironmentManager,
                    createMockLog(),
                );
                return { manager, getPersistedStub, resolveStub };
            },
        },
        {
            name: 'CondaEnvManager',
            managerId: 'ms-python.python:conda',
            persistedPath: path.resolve('test', 'conda', 'envs', 'myenv'),
            createContext: (sandbox: sinon.SinonSandbox) => {
                const getPersistedStub = sandbox.stub(condaUtils, 'getCondaForWorkspace');
                const resolveStub = sandbox.stub(condaUtils, 'resolveCondaPath');
                sandbox.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
                const manager = new CondaEnvManager(createMockNativeFinder(), createMockApi(testUri), createMockLog());
                return { manager, getPersistedStub, resolveStub };
            },
        },
        {
            name: 'SysPythonManager',
            managerId: 'ms-python.python:system',
            persistedPath: path.resolve('test', 'bin', 'python3'),
            supportsGlobalScope: true,
            createContext: (sandbox: sinon.SinonSandbox) => {
                const getPersistedStub = sandbox.stub(sysCache, 'getSystemEnvForWorkspace');
                const resolveStub = sandbox.stub(sysUtils, 'resolveSystemPythonEnvironmentPath');
                sandbox.stub(sysCache, 'getSystemEnvForGlobal').resolves(undefined);
                sandbox.stub(sysUtils, 'refreshPythons').resolves([]);
                const manager = new SysPythonManager(createMockNativeFinder(), createMockApi(testUri), createMockLog());
                return { manager, getPersistedStub, resolveStub };
            },
        },
        {
            name: 'PyEnvManager',
            managerId: 'ms-python.python:pyenv',
            persistedPath: path.resolve('test', '.pyenv', 'versions', '3.11.0', 'bin', 'python'),
            createContext: (sandbox: sinon.SinonSandbox) => {
                const getPersistedStub = sandbox.stub(pyenvUtils, 'getPyenvForWorkspace');
                const resolveStub = sandbox.stub(pyenvUtils, 'resolvePyenvPath');
                sandbox.stub(pyenvUtils, 'refreshPyenv').resolves([]);
                const manager = new PyEnvManager(createMockNativeFinder(), createMockApi(testUri));
                return { manager, getPersistedStub, resolveStub };
            },
        },
        {
            name: 'PipenvManager',
            managerId: 'ms-python.python:pipenv',
            persistedPath: path.resolve('test', '.local', 'share', 'virtualenvs', 'project-abc123', 'bin', 'python'),
            createContext: (sandbox: sinon.SinonSandbox) => {
                const getPersistedStub = sandbox.stub(pipenvUtils, 'getPipenvForWorkspace');
                const resolveStub = sandbox.stub(pipenvUtils, 'resolvePipenvPath');
                sandbox.stub(pipenvUtils, 'refreshPipenv').resolves([]);
                const manager = new PipenvManager(createMockNativeFinder(), createMockApi(testUri));
                return { manager, getPersistedStub, resolveStub };
            },
        },
    ];
}

function runSharedFastPathTests(managerCase: ManagerCase, getSandbox: () => sinon.SinonSandbox): void {
    test('fast path: returns resolved env when persisted path exists and init not started', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub, resolveStub } = managerCase.createContext(sandbox);
        const mockEnv = createMockEnv(managerCase.managerId, managerCase.persistedPath);
        getPersistedStub.resolves(managerCase.persistedPath);
        resolveStub.resolves(mockEnv);

        const result = await manager.get(testUri);

        assert.strictEqual(result, mockEnv);
        assert.ok(getPersistedStub.called);
        assert.ok(resolveStub.called);
    });

    test('slow path: no persisted env', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub, resolveStub } = managerCase.createContext(sandbox);
        getPersistedStub.resolves(undefined);
        stubInitialize(manager, sandbox);

        const result = await manager.get(testUri);

        assert.strictEqual(result, undefined);
        assert.ok(resolveStub.notCalled);
    });

    test('slow path: resolve throws', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub, resolveStub } = managerCase.createContext(sandbox);
        getPersistedStub.resolves(managerCase.persistedPath);
        resolveStub.rejects(new Error('resolve failed'));
        stubInitialize(manager, sandbox);

        const result = await manager.get(testUri);

        assert.strictEqual(result, undefined);
    });

    test('skip fast path: scope is undefined', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub } = managerCase.createContext(sandbox);
        stubInitialize(manager, sandbox);

        await manager.get(undefined);

        // For managers that support global scope, the workspace getPersistedPath may be
        // called by background init (loadEnvMap), so we only assert notCalled for managers
        // that skip the fast path entirely when scope is undefined.
        if (!managerCase.supportsGlobalScope) {
            assert.ok(getPersistedStub.notCalled);
        }
    });

    test('skip fast path: already initialized', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub } = managerCase.createContext(sandbox);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const managerAny = manager as any;
        managerAny._initialized = createDeferred<void>();
        managerAny._initialized.resolve();

        stubInitialize(manager, sandbox);
        await manager.get(testUri);

        assert.ok(getPersistedStub.notCalled);
    });

    test('fast path: still fires when _initialized exists but not completed', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub, resolveStub } = managerCase.createContext(sandbox);
        const mockEnv = createMockEnv(managerCase.managerId, managerCase.persistedPath);
        getPersistedStub.resolves(managerCase.persistedPath);
        resolveStub.resolves(mockEnv);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const managerAny = manager as any;
        managerAny._initialized = createDeferred<void>();

        const result = await manager.get(testUri);

        assert.strictEqual(result, mockEnv);
        assert.ok(getPersistedStub.called);
        assert.ok(resolveStub.called);
    });

    test('fast path: does not replace existing deferred', async () => {
        const sandbox = getSandbox();
        const { manager, getPersistedStub, resolveStub } = managerCase.createContext(sandbox);
        const mockEnv = createMockEnv(managerCase.managerId, managerCase.persistedPath);
        getPersistedStub.resolves(managerCase.persistedPath);
        resolveStub.resolves(mockEnv);

        const existingDeferred = createDeferred<void>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const managerAny = manager as any;
        managerAny._initialized = existingDeferred;

        await manager.get(testUri);

        assert.strictEqual(managerAny._initialized, existingDeferred, 'Should preserve existing deferred');
    });
}

suite('Manager get() fast path', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(windowApis, 'withProgress').callsFake((_opts, cb) => cb(undefined as never, undefined as never));
    });

    teardown(() => {
        sandbox.restore();
    });

    createManagerCases().forEach((managerCase) => {
        suite(managerCase.name, () => {
            runSharedFastPathTests(managerCase, () => sandbox);
        });
    });

    suite('VenvManager specific', () => {
        test('fast path: background init failure resets _initialized for retry', async () => {
            const persistedPath = path.resolve('test-workspace', '.venv');
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            const getVenvStub = sandbox.stub(venvUtils, 'getVenvForWorkspace').resolves(persistedPath);
            const resolveVenvStub = sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(mockEnv);

            const manager = new VenvManager(
                createMockNativeFinder(),
                createMockApi(testUri),
                {} as EnvironmentManager,
                createMockLog(),
            );

            const internalRefreshStub = sandbox.stub(
                manager as unknown as { internalRefresh: () => Promise<void> },
                'internalRefresh',
            );
            internalRefreshStub.rejects(new Error('discovery crashed'));

            const result = await manager.get(testUri);
            assert.strictEqual(result, mockEnv);
            assert.ok(getVenvStub.calledOnce);
            assert.ok(resolveVenvStub.calledOnce);

            await new Promise((resolve) => setImmediate(resolve));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.strictEqual((manager as any)._initialized, undefined, 'Should clear initialized after failure');
        });

        test('fast path: uses scope.fsPath when getPythonProject returns undefined', async () => {
            const persistedPath = path.resolve('test-workspace', '.venv');
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            const getVenvStub = sandbox.stub(venvUtils, 'getVenvForWorkspace').resolves(persistedPath);
            const resolveVenvStub = sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(mockEnv);

            const mockApi = {
                getPythonProject: sinon.stub().returns(undefined),
                getPythonProjects: sinon.stub().returns([]),
                createPythonEnvironmentItem: sinon.stub(),
            } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

            const manager = new VenvManager(
                createMockNativeFinder(),
                mockApi,
                {} as EnvironmentManager,
                createMockLog(),
            );
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.strictEqual(getVenvStub.firstCall.args[0], testUri.fsPath, 'Should fall back to scope.fsPath');
            assert.ok(resolveVenvStub.called);
        });
    });
});
