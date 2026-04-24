/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { DidChangeEnvironmentEventArgs, PythonEnvironmentApi, PythonProject } from '../../../api';
import { normalizePath } from '../../../common/utils/pathUtils';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

function createManager(apiOverrides?: Partial<PythonEnvironmentApi>): CondaEnvManager {
    const api = {
        getPythonProject: sinon.stub().returns(undefined),
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

suite('CondaEnvManager.set - onDidChangeEnvironment event firing', () => {
    let checkNoPythonStub: sinon.SinonStub;

    setup(() => {
        sinon.stub(condaUtils, 'setCondaForGlobal').resolves();
        sinon.stub(condaUtils, 'setCondaForWorkspace').resolves();
        checkNoPythonStub = sinon.stub(condaUtils, 'checkForNoPythonCondaEnvironment');
    });

    teardown(() => {
        sinon.restore();
    });

    test('set(undefined, env) fires onDidChangeEnvironment for global scope', async () => {
        const manager = createManager();
        const oldEnv = makeEnv('base', '/miniconda3', '3.11.0');
        const newEnv = makeEnv('myenv', '/miniconda3/envs/myenv', '3.12.0');
        (manager as any).globalEnv = oldEnv;
        checkNoPythonStub.resolves(newEnv);

        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        await manager.set(undefined, newEnv);

        assert.strictEqual(events.length, 1, 'should fire exactly one event');
        assert.strictEqual(events[0].uri, undefined, 'uri should be undefined for global scope');
        assert.strictEqual(events[0].old, oldEnv);
        assert.strictEqual(events[0].new, newEnv);
    });

    test('set(undefined, env) does not fire event when env is unchanged', async () => {
        const manager = createManager();
        const env = makeEnv('base', '/miniconda3', '3.11.0');
        (manager as any).globalEnv = env;
        checkNoPythonStub.resolves(env);

        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        await manager.set(undefined, env);

        assert.strictEqual(events.length, 0, 'should not fire event when env is unchanged');
    });

    test('set(Uri, env) fires onDidChangeEnvironment for single Uri scope', async () => {
        const projectUri = Uri.file('/workspace/project');
        const project = { uri: projectUri, name: 'project' } as PythonProject;
        const manager = createManager({
            getPythonProject: sinon.stub().returns(project) as any,
        });
        const newEnv = makeEnv('myenv', '/miniconda3/envs/myenv', '3.12.0');
        checkNoPythonStub.resolves(newEnv);

        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        await manager.set(projectUri, newEnv);

        assert.strictEqual(events.length, 1, 'should fire exactly one event');
        assert.strictEqual(events[0].uri, projectUri);
        assert.strictEqual(events[0].old, undefined);
        assert.strictEqual(events[0].new, newEnv);
    });

    test('set(Uri, env) does not fire event when env is unchanged', async () => {
        const projectUri = Uri.file('/workspace/project');
        const project = { uri: projectUri, name: 'project' } as PythonProject;
        const manager = createManager({
            getPythonProject: sinon.stub().returns(project) as any,
        });
        const env = makeEnv('myenv', '/miniconda3/envs/myenv', '3.12.0');
        checkNoPythonStub.resolves(env);

        // Pre-populate the map with the same env
        (manager as any).fsPathToEnv.set(normalizePath(projectUri.fsPath), env);

        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        await manager.set(projectUri, env);

        assert.strictEqual(events.length, 0, 'should not fire event when env is unchanged');
    });

    test('set(Uri, undefined) fires event when clearing environment', async () => {
        const projectUri = Uri.file('/workspace/project');
        const project = { uri: projectUri, name: 'project' } as PythonProject;
        const manager = createManager({
            getPythonProject: sinon.stub().returns(project) as any,
        });
        const oldEnv = makeEnv('myenv', '/miniconda3/envs/myenv', '3.12.0');

        // Pre-populate the map
        (manager as any).fsPathToEnv.set(normalizePath(projectUri.fsPath), oldEnv);

        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        await manager.set(projectUri, undefined);

        assert.strictEqual(events.length, 1, 'should fire event when clearing');
        assert.strictEqual(events[0].old, oldEnv);
        assert.strictEqual(events[0].new, undefined);
    });
});
