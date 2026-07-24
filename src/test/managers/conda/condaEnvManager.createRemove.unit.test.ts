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
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

const TEST_ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'conda-manager')).fsPath;
const DEFAULT_CONDA_PREFIX = path.join(TEST_ROOT, 'miniconda3');

function testPath(...segments: string[]): string {
    return path.join(TEST_ROOT, ...segments);
}

function flushSetImmediate(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function createManager(apiOverrides?: Partial<PythonEnvironmentApi>): CondaEnvManager {
    const api = {
        getPythonProject: sinon.stub().returns(undefined),
        getPythonProjects: sinon.stub().returns([]),
        ...apiOverrides,
    } as any as PythonEnvironmentApi;
    const manager = new CondaEnvManager(
        {} as NativePythonFinder,
        api,
        { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
    );
    (manager as any)._initialized = { completed: true, promise: Promise.resolve() };
    (manager as any).collection = [];
    return manager;
}

suite('CondaEnvManager.create - orchestration', () => {
    let createCondaStub: sinon.SinonStub;
    let generateNameStub: sinon.SinonStub;
    let getDefaultPrefixStub: sinon.SinonStub;
    let quickCreateStub: sinon.SinonStub;
    let showErrorStub: sinon.SinonStub;

    setup(() => {
        createCondaStub = sinon.stub(condaUtils, 'createCondaEnvironment');
        quickCreateStub = sinon.stub(condaUtils, 'quickCreateConda');
        getDefaultPrefixStub = sinon.stub(condaUtils, 'getDefaultCondaPrefix').resolves(DEFAULT_CONDA_PREFIX);
        generateNameStub = sinon.stub(condaUtils, 'generateName').resolves('./.conda');
        showErrorStub = sinon.stub(windowApis, 'showErrorMessage');
    });

    teardown(() => {
        sinon.restore();
    });

    test('non-quick create delegates, caches the environment, and fires an add event', async () => {
        const manager = createManager();
        const env = makeEnv('myenv', testPath('miniconda3', 'envs', 'myenv'), '3.12.0');
        createCondaStub.resolves(env);
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => events.push(event));
        const scope = Uri.file(testPath('workspace', 'project'));

        const result = await manager.create(scope, undefined);

        assert.strictEqual(result, env);
        assert.strictEqual(createCondaStub.firstCall.args[3], scope);
        assert.ok(quickCreateStub.notCalled);
        assert.deepStrictEqual((manager as any).collection, [env]);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0][0].kind, EnvironmentChangeKind.add);
        assert.strictEqual(events[0][0].environment, env);
    });

    test('global quick create resolves a prefix and forwards additional packages', async () => {
        const manager = createManager();
        const env = makeEnv('global-env', testPath('miniconda3', 'envs', 'global-env'), '3.12.0');
        quickCreateStub.resolves(env);

        const result = await manager.create('global', {
            quickCreate: true,
            additionalPackages: ['pytest'],
        });

        assert.strictEqual(result, env);
        assert.ok(getDefaultPrefixStub.calledOnce);
        assert.ok(generateNameStub.calledOnceWith(DEFAULT_CONDA_PREFIX));
        assert.strictEqual(quickCreateStub.firstCall.args[3], DEFAULT_CONDA_PREFIX);
        assert.strictEqual(quickCreateStub.firstCall.args[4], './.conda');
        assert.deepStrictEqual(quickCreateStub.firstCall.args[5], ['pytest']);
    });

    test('project quick create uses the project root and writes .gitignore', async () => {
        const tempRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'condamgr-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            const envPath = path.join(projectUri.fsPath, '.conda');
            await fse.mkdirp(envPath);
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const manager = createManager({
                getPythonProject: sinon.stub().returns(project),
                getPythonProjects: sinon.stub().returns([project]),
            });
            const env = makeEnv('project-env', envPath, '3.12.0');
            quickCreateStub.resolves(env);

            const result = await manager.create(projectUri, { quickCreate: true });

            assert.strictEqual(result, env);
            assert.ok(getDefaultPrefixStub.notCalled);
            assert.strictEqual(quickCreateStub.firstCall.args[3], projectUri.fsPath);
            assert.strictEqual(await fse.readFile(path.join(envPath, '.gitignore'), 'utf8'), '*\n');
        } finally {
            await fse.remove(tempRoot);
        }
    });

    test('does not mutate state when creation returns no environment', async () => {
        const manager = createManager();
        createCondaStub.resolves(undefined);
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => events.push(event));

        const result = await manager.create(Uri.file(testPath('workspace', 'project')), undefined);

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual((manager as any).collection, []);
        assert.strictEqual(events.length, 0);
    });

    test('reports thrown creation errors without mutating state', async () => {
        const manager = createManager();
        createCondaStub.rejects(new Error('creation failed'));

        const result = await manager.create(Uri.file(testPath('workspace', 'project')), undefined);

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual((manager as any).collection, []);
        assert.ok(showErrorStub.calledOnce);
    });
});

suite('CondaEnvManager.remove - orchestration', () => {
    let deleteCondaStub: sinon.SinonStub;

    setup(() => {
        deleteCondaStub = sinon.stub(condaUtils, 'deleteCondaEnvironment');
    });

    teardown(() => {
        sinon.restore();
    });

    test('successful removal updates caches and fires collection and project events', async () => {
        const projectUri = Uri.file(testPath('workspace', 'project'));
        const project = { name: 'project', uri: projectUri } as PythonProject;
        const manager = createManager({ getPythonProject: sinon.stub().returns(project) });
        const env = makeEnv('project-env', testPath('workspace', 'project', '.conda'), '3.12.0');
        (manager as any).collection = [env];
        (manager as any).fsPathToEnv = new Map<string, PythonEnvironment>([[projectUri.fsPath, env]]);
        deleteCondaStub.resolves(true);
        const environmentEvents: DidChangeEnvironmentsEventArgs[] = [];
        const selectionEvents: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => environmentEvents.push(event));
        manager.onDidChangeEnvironment((event) => selectionEvents.push(event));

        await manager.remove(env);
        await flushSetImmediate();

        assert.ok(deleteCondaStub.calledOnceWithExactly(env, (manager as any).log));
        assert.deepStrictEqual((manager as any).collection, []);
        assert.strictEqual((manager as any).fsPathToEnv.size, 0);
        assert.strictEqual(environmentEvents.length, 1);
        assert.strictEqual(environmentEvents[0][0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(selectionEvents.length, 1);
        assert.strictEqual(selectionEvents[0].uri, projectUri);
        assert.strictEqual(selectionEvents[0].old, env);
        assert.strictEqual(selectionEvents[0].new, undefined);
    });

    test('logs rejected deletion without firing a success event', async () => {
        const manager = createManager();
        const env = makeEnv('project-env', testPath('workspace', 'project', '.conda'), '3.12.0');
        (manager as any).collection = [env];
        deleteCondaStub.rejects(new Error('removal failed'));
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => events.push(event));

        await manager.remove(env);
        await flushSetImmediate();

        assert.strictEqual(events.length, 0);
        assert.ok(((manager as any).log.error as sinon.SinonStub).called);
    });
});
