import * as assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
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
            .callsFake((_info: unknown, _mgr: unknown) => createMockEnv('test', 'resolved')),
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

/**
 * Stubs initialize on a manager instance so it completes immediately
 * without doing real discovery work. Used for tests that exercise
 * the slow-path fallthrough in get().
 */
function stubInitialize(manager: { initialize: () => Promise<void> }, sandbox: sinon.SinonSandbox): void {
    sandbox.stub(manager, 'initialize').resolves();
}

/**
 * Tests for the fast path optimization in manager.get().
 *
 * When a manager hasn't completed initialization yet and a persisted
 * environment path exists in workspace state, get() should resolve it
 * directly via nativeFinder.resolve() and return immediately — without
 * waiting for full discovery. Background init is kicked off concurrently.
 */
suite('Manager get() fast path', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(windowApis, 'withProgress').callsFake((_opts, cb) => cb(undefined as never, undefined as never));
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('VenvManager', () => {
        let getVenvStub: sinon.SinonStub;
        let resolveVenvStub: sinon.SinonStub;
        const testUri = Uri.file('/test/workspace');
        const persistedPath = '/test/workspace/.venv';

        setup(() => {
            getVenvStub = sandbox.stub(venvUtils, 'getVenvForWorkspace');
            resolveVenvStub = sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath');
        });

        function createVenvManager(): VenvManager {
            return new VenvManager(
                createMockNativeFinder(),
                createMockApi(testUri),
                {} as EnvironmentManager,
                createMockLog(),
            );
        }

        test('fast path: returns resolved env when persisted path exists and init not started', async () => {
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(mockEnv);

            const manager = createVenvManager();
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getVenvStub.called);
            assert.ok(resolveVenvStub.called);
        });

        test('slow path: no persisted env', async () => {
            getVenvStub.resolves(undefined);
            const manager = createVenvManager();
            stubInitialize(manager, sandbox);

            const result = await manager.get(testUri);

            assert.strictEqual(result, undefined);
            assert.ok(getVenvStub.calledOnce);
            assert.ok(resolveVenvStub.notCalled);
        });

        test('slow path: resolve throws', async () => {
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.rejects(new Error('resolve failed'));
            const manager = createVenvManager();
            stubInitialize(manager, sandbox);

            const result = await manager.get(testUri);

            assert.strictEqual(result, undefined);
        });

        test('slow path: resolve returns undefined', async () => {
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(undefined);
            const manager = createVenvManager();
            stubInitialize(manager, sandbox);

            const result = await manager.get(testUri);

            assert.strictEqual(result, undefined);
        });

        test('skip fast path: scope is undefined', async () => {
            const manager = createVenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(undefined);

            assert.ok(getVenvStub.notCalled);
        });

        test('skip fast path: already initialized', async () => {
            const manager = createVenvManager();
            // Simulate completed initialization
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            m._initialized = createDeferred();
            m._initialized.resolve();

            stubInitialize(manager, sandbox);
            await manager.get(testUri);

            assert.ok(getVenvStub.notCalled);
        });

        test('fast path: kicks off background init when _initialized is undefined', async () => {
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(mockEnv);

            const manager = createVenvManager();
            await manager.get(testUri);

            // After fast path, _initialized should exist (background init kicked off)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.ok((manager as any)._initialized, 'Background init should be started');
        });

        test('fast path: still fires when _initialized exists but not completed (concurrent caller)', async () => {
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(mockEnv);

            const manager = createVenvManager();
            // Simulate another caller (e.g. autoDiscover) having started init but not finished
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            m._initialized = createDeferred();
            // NOT resolved — init is in progress

            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv, 'Fast path should still return env when init is in-progress');
            assert.ok(getVenvStub.called, 'Should check persisted state');
            assert.ok(resolveVenvStub.called, 'Should resolve the persisted path');
        });

        test('fast path: does not create second deferred when _initialized already exists', async () => {
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(mockEnv);

            const manager = createVenvManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            const existingDeferred = createDeferred();
            m._initialized = existingDeferred;

            await manager.get(testUri);

            // The original deferred should be preserved, not replaced
            assert.strictEqual(m._initialized, existingDeferred, 'Should not replace existing deferred');
        });

        test('fast path: background init failure still resolves deferred', async () => {
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(mockEnv);
            // Make withProgress reject (simulates internalRefresh failure)
            sandbox.restore();
            sandbox = sinon.createSandbox();
            sandbox.stub(windowApis, 'withProgress').rejects(new Error('discovery crashed'));
            getVenvStub = sandbox.stub(venvUtils, 'getVenvForWorkspace').resolves(persistedPath);
            resolveVenvStub = sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(mockEnv);

            const manager = new VenvManager(
                createMockNativeFinder(),
                createMockApi(testUri),
                {} as EnvironmentManager,
                createMockLog(),
            );
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv, 'Should still return resolved env');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const deferred = (manager as any)._initialized;
            assert.ok(deferred, 'Deferred should exist');
            // Wait for the background init to settle (it should resolve despite the error)
            await deferred.promise;
            assert.ok(deferred.completed, 'Deferred should be resolved even after background failure');
        });

        test('fast path: uses scope.fsPath when getPythonProject returns undefined', async () => {
            const mockEnv = createMockEnv('ms-python.python:venv', persistedPath);
            getVenvStub.resolves(persistedPath);
            resolveVenvStub.resolves(mockEnv);

            // Create API where getPythonProject returns undefined
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
            // getVenvForWorkspace should be called with the raw scope.fsPath
            const calledWith = getVenvStub.firstCall.args[0] as string;
            assert.strictEqual(calledWith, testUri.fsPath, 'Should fall back to scope.fsPath');
        });
    });

    suite('CondaEnvManager', () => {
        let getCondaStub: sinon.SinonStub;
        let resolveCondaStub: sinon.SinonStub;
        const testUri = Uri.file('/test/workspace');
        const persistedPath = '/test/conda/envs/myenv';

        setup(() => {
            getCondaStub = sandbox.stub(condaUtils, 'getCondaForWorkspace');
            resolveCondaStub = sandbox.stub(condaUtils, 'resolveCondaPath');
            sandbox.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        });

        function createCondaManager(): CondaEnvManager {
            return new CondaEnvManager(createMockNativeFinder(), createMockApi(testUri), createMockLog());
        }

        test('fast path: returns resolved env when persisted path exists and init not started', async () => {
            const mockEnv = createMockEnv('ms-python.python:conda', persistedPath);
            getCondaStub.resolves(persistedPath);
            resolveCondaStub.resolves(mockEnv);

            const manager = createCondaManager();
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getCondaStub.called);
            assert.ok(resolveCondaStub.called);
        });

        test('slow path: no persisted env', async () => {
            getCondaStub.resolves(undefined);
            const manager = createCondaManager();
            stubInitialize(manager, sandbox);

            const result = await manager.get(testUri);

            assert.strictEqual(result, undefined);
            assert.ok(resolveCondaStub.notCalled);
        });

        test('slow path: resolve throws', async () => {
            getCondaStub.resolves(persistedPath);
            resolveCondaStub.rejects(new Error('resolve failed'));
            const manager = createCondaManager();
            stubInitialize(manager, sandbox);

            const result = await manager.get(testUri);

            assert.strictEqual(result, undefined);
        });

        test('skip fast path: scope is undefined', async () => {
            const manager = createCondaManager();
            stubInitialize(manager, sandbox);

            await manager.get(undefined);

            assert.ok(getCondaStub.notCalled);
        });

        test('skip fast path: already initialized', async () => {
            const manager = createCondaManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            m._initialized = createDeferred();
            m._initialized.resolve();

            stubInitialize(manager, sandbox);
            await manager.get(testUri);

            assert.ok(getCondaStub.notCalled);
        });

        test('fast path: still fires when _initialized exists but not completed', async () => {
            const mockEnv = createMockEnv('ms-python.python:conda', persistedPath);
            getCondaStub.resolves(persistedPath);
            resolveCondaStub.resolves(mockEnv);

            const manager = createCondaManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (manager as any)._initialized = createDeferred(); // in-progress, not resolved

            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getCondaStub.called);
        });
    });

    suite('SysPythonManager', () => {
        let getSysStub: sinon.SinonStub;
        let resolveSysStub: sinon.SinonStub;
        const testUri = Uri.file('/test/workspace');
        const persistedPath = '/usr/bin/python3.11';

        setup(() => {
            getSysStub = sandbox.stub(sysCache, 'getSystemEnvForWorkspace');
            resolveSysStub = sandbox.stub(sysUtils, 'resolveSystemPythonEnvironmentPath');
            sandbox.stub(sysUtils, 'refreshPythons').resolves([]);
        });

        function createSysManager(): SysPythonManager {
            return new SysPythonManager(createMockNativeFinder(), createMockApi(testUri), createMockLog());
        }

        test('fast path: returns resolved env when persisted path exists and init not started', async () => {
            const mockEnv = createMockEnv('ms-python.python:system', persistedPath);
            getSysStub.resolves(persistedPath);
            resolveSysStub.resolves(mockEnv);

            const manager = createSysManager();
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getSysStub.called);
            assert.ok(resolveSysStub.called);
        });

        test('slow path: no persisted env', async () => {
            getSysStub.resolves(undefined);
            const manager = createSysManager();
            stubInitialize(manager, sandbox);

            await manager.get(testUri);

            assert.ok(resolveSysStub.notCalled);
        });

        test('slow path: resolve throws', async () => {
            getSysStub.resolves(persistedPath);
            resolveSysStub.rejects(new Error('resolve failed'));
            const manager = createSysManager();
            stubInitialize(manager, sandbox);

            await manager.get(testUri);

            assert.ok(true, 'Should not throw');
        });

        test('skip fast path: scope is undefined', async () => {
            const manager = createSysManager();
            stubInitialize(manager, sandbox);

            await manager.get(undefined);

            assert.ok(getSysStub.notCalled);
        });

        test('skip fast path: already initialized', async () => {
            const manager = createSysManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            m._initialized = createDeferred();
            m._initialized.resolve();

            stubInitialize(manager, sandbox);
            await manager.get(testUri);

            assert.ok(getSysStub.notCalled);
        });

        test('fast path: still fires when _initialized exists but not completed', async () => {
            const mockEnv = createMockEnv('ms-python.python:system', persistedPath);
            getSysStub.resolves(persistedPath);
            resolveSysStub.resolves(mockEnv);

            const manager = createSysManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (manager as any)._initialized = createDeferred(); // in-progress, not resolved

            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getSysStub.called);
        });
    });

    suite('PyEnvManager', () => {
        let getPyenvStub: sinon.SinonStub;
        let resolvePyenvStub: sinon.SinonStub;
        const testUri = Uri.file('/test/workspace');
        const persistedPath = '/home/user/.pyenv/versions/3.11.0/bin/python';

        setup(() => {
            getPyenvStub = sandbox.stub(pyenvUtils, 'getPyenvForWorkspace');
            resolvePyenvStub = sandbox.stub(pyenvUtils, 'resolvePyenvPath');
            sandbox.stub(pyenvUtils, 'refreshPyenv').resolves([]);
        });

        function createPyenvManager(): PyEnvManager {
            return new PyEnvManager(createMockNativeFinder(), createMockApi(testUri));
        }

        test('fast path: returns resolved env when persisted path exists and init not started', async () => {
            const mockEnv = createMockEnv('ms-python.python:pyenv', persistedPath);
            getPyenvStub.resolves(persistedPath);
            resolvePyenvStub.resolves(mockEnv);

            const manager = createPyenvManager();
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getPyenvStub.called);
            assert.ok(resolvePyenvStub.called);
        });

        test('slow path: no persisted env', async () => {
            getPyenvStub.resolves(undefined);
            const manager = createPyenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(testUri);

            assert.ok(resolvePyenvStub.notCalled);
        });

        test('slow path: resolve throws', async () => {
            getPyenvStub.resolves(persistedPath);
            resolvePyenvStub.rejects(new Error('resolve failed'));
            const manager = createPyenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(testUri);

            assert.ok(true, 'Should not throw');
        });

        test('skip fast path: scope is undefined', async () => {
            const manager = createPyenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(undefined);

            assert.ok(getPyenvStub.notCalled);
        });

        test('skip fast path: already initialized', async () => {
            const manager = createPyenvManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            m._initialized = createDeferred();
            m._initialized.resolve();

            stubInitialize(manager, sandbox);
            await manager.get(testUri);

            assert.ok(getPyenvStub.notCalled);
        });

        test('fast path: still fires when _initialized exists but not completed', async () => {
            const mockEnv = createMockEnv('ms-python.python:pyenv', persistedPath);
            getPyenvStub.resolves(persistedPath);
            resolvePyenvStub.resolves(mockEnv);

            const manager = createPyenvManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (manager as any)._initialized = createDeferred(); // in-progress, not resolved

            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getPyenvStub.called);
        });
    });

    suite('PipenvManager', () => {
        let getPipenvStub: sinon.SinonStub;
        let resolvePipenvStub: sinon.SinonStub;
        const testUri = Uri.file('/test/workspace');
        const persistedPath = '/home/user/.local/share/virtualenvs/project-abc123/bin/python';

        setup(() => {
            getPipenvStub = sandbox.stub(pipenvUtils, 'getPipenvForWorkspace');
            resolvePipenvStub = sandbox.stub(pipenvUtils, 'resolvePipenvPath');
            sandbox.stub(pipenvUtils, 'refreshPipenv').resolves([]);
        });

        function createPipenvManager(): PipenvManager {
            return new PipenvManager(createMockNativeFinder(), createMockApi(testUri));
        }

        test('fast path: returns resolved env when persisted path exists and init not started', async () => {
            const mockEnv = createMockEnv('ms-python.python:pipenv', persistedPath);
            getPipenvStub.resolves(persistedPath);
            resolvePipenvStub.resolves(mockEnv);

            const manager = createPipenvManager();
            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            // getPipenvForWorkspace may be called more than once: once by the fast path,
            // and again by background init's loadEnvMap (since withProgress is synchronous in tests)
            assert.ok(getPipenvStub.called);
            assert.ok(resolvePipenvStub.called);
        });

        test('slow path: no persisted env', async () => {
            getPipenvStub.resolves(undefined);
            const manager = createPipenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(testUri);

            assert.ok(resolvePipenvStub.notCalled);
        });

        test('slow path: resolve throws', async () => {
            getPipenvStub.resolves(persistedPath);
            resolvePipenvStub.rejects(new Error('resolve failed'));
            const manager = createPipenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(testUri);

            assert.ok(true, 'Should not throw');
        });

        test('skip fast path: scope is undefined', async () => {
            const manager = createPipenvManager();
            stubInitialize(manager, sandbox);

            await manager.get(undefined);

            assert.ok(getPipenvStub.notCalled);
        });

        test('skip fast path: already initialized', async () => {
            const manager = createPipenvManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = manager as any;
            m._initialized = createDeferred();
            m._initialized.resolve();

            stubInitialize(manager, sandbox);
            await manager.get(testUri);

            assert.ok(getPipenvStub.notCalled);
        });

        test('fast path: still fires when _initialized exists but not completed', async () => {
            const mockEnv = createMockEnv('ms-python.python:pipenv', persistedPath);
            getPipenvStub.resolves(persistedPath);
            resolvePipenvStub.resolves(mockEnv);

            const manager = createPipenvManager();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (manager as any)._initialized = createDeferred(); // in-progress, not resolved

            const result = await manager.get(testUri);

            assert.strictEqual(result, mockEnv);
            assert.ok(getPipenvStub.called);
        });
    });
});
