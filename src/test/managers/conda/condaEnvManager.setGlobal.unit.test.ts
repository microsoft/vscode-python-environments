/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { PythonEnvironmentApi } from '../../../api';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

function createManager(): CondaEnvManager {
    const manager = new CondaEnvManager(
        {} as NativePythonFinder,
        {} as PythonEnvironmentApi,
        { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
    );
    // Bypass initialization
    (manager as any)._initialized = { completed: true, promise: Promise.resolve() };
    (manager as any).collection = [];
    return manager;
}

suite('CondaEnvManager.set - globalEnv update', () => {
    let setCondaForGlobalStub: sinon.SinonStub;
    let checkNoPythonStub: sinon.SinonStub;

    setup(() => {
        setCondaForGlobalStub = sinon.stub(condaUtils, 'setCondaForGlobal').resolves();
        checkNoPythonStub = sinon.stub(condaUtils, 'checkForNoPythonCondaEnvironment');
    });

    teardown(() => {
        sinon.restore();
    });

    test('set(undefined, env) updates globalEnv in memory', async () => {
        const manager = createManager();
        const oldEnv = makeEnv('base', '/miniconda3', '3.11.0');
        const newEnv = makeEnv('myenv', '/miniconda3/envs/myenv', '3.12.0');
        (manager as any).globalEnv = oldEnv;

        // checkForNoPythonCondaEnvironment returns the env as-is (has Python)
        checkNoPythonStub.resolves(newEnv);

        await manager.set(undefined, newEnv);

        // globalEnv should now be updated in memory
        const result = await manager.get(undefined);
        assert.strictEqual(result, newEnv, 'get(undefined) should return the newly set environment');
        assert.notStrictEqual(result, oldEnv, 'get(undefined) should NOT return the old environment');
    });

    test('set(undefined, env) persists to disk', async () => {
        const manager = createManager();
        const newEnv = makeEnv('myenv', '/miniconda3/envs/myenv', '3.12.0');
        checkNoPythonStub.resolves(newEnv);

        await manager.set(undefined, newEnv);

        assert.ok(setCondaForGlobalStub.calledOnce, 'setCondaForGlobal should be called');
        assert.strictEqual(
            setCondaForGlobalStub.firstCall.args[0],
            newEnv.environmentPath.fsPath,
            'should persist the correct path',
        );
    });

    test('set(undefined, undefined) clears globalEnv', async () => {
        const manager = createManager();
        const oldEnv = makeEnv('base', '/miniconda3', '3.11.0');
        (manager as any).globalEnv = oldEnv;

        await manager.set(undefined, undefined);

        const result = await manager.get(undefined);
        assert.strictEqual(result, undefined, 'get(undefined) should return undefined after clearing');
    });

    test('set(undefined, noPythonEnv) where user declines install clears globalEnv', async () => {
        const manager = createManager();
        const oldEnv = makeEnv('base', '/miniconda3', '3.11.0');
        const noPythonEnv = makeEnv('nopy', '/miniconda3/envs/nopy', 'no-python');
        (manager as any).globalEnv = oldEnv;

        // User declined to install Python
        checkNoPythonStub.resolves(undefined);

        await manager.set(undefined, noPythonEnv);

        const result = await manager.get(undefined);
        assert.strictEqual(result, undefined, 'globalEnv should be cleared when checkedEnv is undefined');
    });
});
