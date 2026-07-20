/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../../api';
import * as commandApis from '../../../common/command.api';
import { VENV_MANAGER_ID } from '../../../common/constants';
import { normalizePath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import * as envCommands from '../../../features/envCommands';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

const TEST_ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'venv-manager')).fsPath;

function testPath(...segments: string[]): string {
    return path.join(TEST_ROOT, ...segments);
}

function venvPythonPath(venvRoot: string): string {
    return path.join(venvRoot, process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
}

function createManager(
    apiOverrides?: Partial<PythonEnvironmentApi>,
    baseEnvironments: PythonEnvironment[] = [],
): VenvManager {
    const api = {
        getEnvironments: sinon.stub().resolves([]),
        getPythonProject: sinon.stub().returns(undefined),
        getPythonProjects: sinon.stub().returns([]),
        refreshEnvironments: sinon.stub().resolves(undefined),
        ...apiOverrides,
    } as any as PythonEnvironmentApi;
    const baseManager = {
        getEnvironments: sinon.stub().resolves(baseEnvironments),
    } as any as EnvironmentManager;
    const manager = new VenvManager(
        {} as NativePythonFinder,
        api,
        baseManager,
        { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
    );
    (manager as any)._initialized = { completed: true, promise: Promise.resolve() };
    (manager as any).collection = [];
    return manager;
}

suite('VenvManager.create - orchestration', () => {
    let createPythonVenvStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    let quickCreateVenvStub: sinon.SinonStub;
    let showErrorStub: sinon.SinonStub;
    let envDir: string;
    let pythonPath: string;
    let tmpRoot: string;

    setup(async () => {
        createPythonVenvStub = sinon.stub(venvUtils, 'createPythonVenv');
        quickCreateVenvStub = sinon.stub(venvUtils, 'quickCreateVenv');
        sinon.stub(envCommands, 'findParentIfFile').callsFake(async (value: string) => value);
        showErrorStub = sinon.stub(windowApis, 'showErrorMessage');
        executeCommandStub = sinon.stub(commandApis, 'executeCommand').resolves();

        tmpRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'venvmgr-'));
        envDir = Uri.file(path.join(tmpRoot, 'project', '.venv')).fsPath;
        pythonPath = venvPythonPath(envDir);
        await fse.outputFile(pythonPath, '');
    });

    teardown(async () => {
        sinon.restore();
        if (tmpRoot) {
            await fse.remove(tmpRoot);
        }
    });

    function createdEnvironment(): PythonEnvironment {
        return createMockPythonEnvironment({
            name: '.venv',
            envPath: pythonPath,
            sysPrefix: envDir,
            version: '3.12.0',
            managerId: VENV_MANAGER_ID,
        });
    }

    test('non-quick create delegates, caches the environment, and performs side effects', async () => {
        const globalEnv = createMockPythonEnvironment({
            name: 'global',
            envPath: testPath('global', 'python3'),
            version: '3.12.0',
        });
        const created = createdEnvironment();
        const manager = createManager({ getEnvironments: sinon.stub().resolves([globalEnv]) });
        createPythonVenvStub.resolves({ environment: created });
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => events.push(event));
        const scope = Uri.file(path.join(tmpRoot, 'project'));

        const result = await manager.create(scope, undefined);

        assert.strictEqual(result, created);
        assert.deepStrictEqual(createPythonVenvStub.firstCall.args[4], [globalEnv]);
        assert.strictEqual(createPythonVenvStub.firstCall.args[5].fsPath, scope.fsPath);
        assert.deepStrictEqual(createPythonVenvStub.firstCall.args[6], { showQuickAndCustomOptions: true });
        assert.deepStrictEqual((manager as any).collection, [created]);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0][0].kind, EnvironmentChangeKind.add);
        assert.strictEqual(await fse.readFile(path.join(envDir, '.gitignore'), 'utf8'), '*\n');
        assert.ok(executeCommandStub.calledOnceWithExactly('revealInExplorer', Uri.file(envDir)));
    });

    test('quick create uses the selected global Python and forwards additional packages', async () => {
        const globalEnv = createMockPythonEnvironment({
            name: 'global',
            envPath: testPath('global', 'python3'),
            version: '3.12.0',
        });
        const created = createdEnvironment();
        const manager = createManager({ getEnvironments: sinon.stub().resolves([globalEnv]) });
        (manager as any).globalEnv = globalEnv;
        quickCreateVenvStub.resolves({ environment: created });
        const scope = Uri.file(path.join(tmpRoot, 'project'));

        const result = await manager.create(scope, { quickCreate: true, additionalPackages: ['pytest'] });

        assert.strictEqual(result, created);
        assert.ok(createPythonVenvStub.notCalled);
        assert.strictEqual(quickCreateVenvStub.firstCall.args[4], globalEnv);
        assert.strictEqual(quickCreateVenvStub.firstCall.args[5].fsPath, scope.fsPath);
        assert.deepStrictEqual(quickCreateVenvStub.firstCall.args[6], ['pytest']);
    });

    test('reports creation errors without adding an environment', async () => {
        const manager = createManager({
            getEnvironments: sinon.stub().resolves([
                createMockPythonEnvironment({
                    name: 'global',
                    envPath: testPath('global', 'python3'),
                    version: '3.12.0',
                }),
            ]),
        });
        createPythonVenvStub.resolves({ envCreationErr: 'creation failed' });

        const result = await manager.create(Uri.file(path.join(tmpRoot, 'project')), undefined);

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual((manager as any).collection, []);
        assert.ok(showErrorStub.calledOnce);
    });

    test('restores the watcher guard when creation throws', async () => {
        const manager = createManager({
            getEnvironments: sinon.stub().resolves([
                createMockPythonEnvironment({
                    name: 'global',
                    envPath: testPath('global', 'python3'),
                    version: '3.12.0',
                }),
            ]),
        });
        createPythonVenvStub.rejects(new Error('creation failed'));

        await assert.rejects(manager.create(Uri.file(path.join(tmpRoot, 'project')), undefined), /creation failed/);

        assert.strictEqual((manager as any).skipWatcherRefresh, false);
    });
});

suite('VenvManager.remove - orchestration', () => {
    let removeVenvStub: sinon.SinonStub;

    setup(() => {
        removeVenvStub = sinon.stub(venvUtils, 'removeVenv');
        sinon.stub(venvUtils, 'setVenvForGlobal').resolves();
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
    });

    teardown(() => {
        sinon.restore();
    });

    function environment(): PythonEnvironment {
        const root = testPath('workspace', 'project', '.venv');
        return createMockPythonEnvironment({
            name: '.venv',
            envPath: venvPythonPath(root),
            sysPrefix: root,
            version: '3.12.0',
            managerId: VENV_MANAGER_ID,
        });
    }

    test('successful removal updates the collection and fires a remove event', async () => {
        const manager = createManager();
        const env = environment();
        (manager as any).collection = [env];
        removeVenvStub.resolves(true);
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => events.push(event));

        await manager.remove(env);

        assert.deepStrictEqual((manager as any).collection, []);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0][0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(events[0][0].environment, env);
    });

    test('does not mutate state when the removal helper returns false', async () => {
        const manager = createManager();
        const env = environment();
        (manager as any).collection = [env];
        removeVenvStub.resolves(false);
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => events.push(event));

        await manager.remove(env);

        assert.deepStrictEqual((manager as any).collection, [env]);
        assert.strictEqual(events.length, 0);
    });

    test('clears mapped project state and reports the effective fallback', async () => {
        const projectUri = Uri.file(testPath('workspace', 'project'));
        const project = { name: 'project', uri: projectUri };
        const fallback = createMockPythonEnvironment({
            name: 'global',
            envPath: testPath('global', 'python3'),
            version: '3.13.0',
        });
        const manager = createManager({ getPythonProject: sinon.stub().returns(project) }, [fallback]);
        const env = environment();
        (manager as any).collection = [env];
        (manager as any).globalEnv = fallback;
        (manager as any).fsPathToEnv = new Map([[normalizePath(projectUri.fsPath), env]]);
        removeVenvStub.resolves(true);
        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((event) => events.push(event));

        await manager.remove(env);

        assert.strictEqual((manager as any).fsPathToEnv.size, 0);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(normalizePath(events[0].uri!.fsPath), normalizePath(projectUri.fsPath));
        assert.strictEqual(events[0].old, env);
        assert.strictEqual(events[0].new, fallback);
    });

    test('clears the current global environment', async () => {
        const manager = createManager();
        const env = environment();
        (manager as any).collection = [env];
        (manager as any).globalEnv = env;
        removeVenvStub.resolves(true);
        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((event) => events.push(event));

        await manager.remove(env);

        assert.strictEqual((manager as any).globalEnv, undefined);
        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0], { uri: undefined, old: env, new: undefined });
    });

    test('restores the watcher guard when removal throws', async () => {
        const manager = createManager();
        removeVenvStub.rejects(new Error('removal failed'));

        await assert.rejects(manager.remove(environment()), /removal failed/);

        assert.strictEqual((manager as any).skipWatcherRefresh, false);
    });
});
