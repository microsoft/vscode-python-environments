import * as assert from 'assert';
import * as sinon from 'sinon';
import * as persistentState from '../../../common/persistentState';
import {
    UV_ENVS_KEY,
    addUvEnvironment,
    clearUvEnvironments,
    getUvEnvironments,
    removeUvEnvironment,
} from '../../../managers/builtin/uvEnvironments';
import { clearVenvCache } from '../../../managers/builtin/venvUtils';

suite('venvUtils UV Environment Tracking', () => {
    let mockState: {
        get: sinon.SinonStub;
        set: sinon.SinonStub;
        clear: sinon.SinonStub;
    };
    let getWorkspacePersistentStateStub: sinon.SinonStub;

    setup(() => {
        mockState = {
            get: sinon.stub(),
            set: sinon.stub(),
            clear: sinon.stub(),
        };
        getWorkspacePersistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        getWorkspacePersistentStateStub.returns(Promise.resolve(mockState));
    });

    teardown(() => {
        sinon.restore();
    });

    test('getUvEnvironments should return empty array when no environments stored', async () => {
        mockState.get.withArgs(UV_ENVS_KEY).resolves(undefined);

        const result = await getUvEnvironments();
        assert.deepStrictEqual(result, []);
    });

    test('getUvEnvironments should return stored environments', async () => {
        const expectedEnvs = ['/path/to/env1', '/path/to/env2'];
        mockState.get.withArgs(UV_ENVS_KEY).resolves(expectedEnvs);

        const result = await getUvEnvironments();
        assert.deepStrictEqual(result, expectedEnvs);
    });

    test('addUvEnvironment should add new environment to list', async () => {
        const existingEnvs = ['/path/to/env1'];
        const newEnvPath = '/path/to/env2';
        mockState.get.withArgs(UV_ENVS_KEY).resolves(existingEnvs);

        await addUvEnvironment(newEnvPath);

        assert.ok(mockState.set.calledWith(UV_ENVS_KEY, ['/path/to/env1', '/path/to/env2']));
    });

    test('addUvEnvironment should not add duplicate environment', async () => {
        const existingEnvs = ['/path/to/env1', '/path/to/env2'];
        const duplicateEnvPath = '/path/to/env1';
        mockState.get.withArgs(UV_ENVS_KEY).resolves(existingEnvs);

        await addUvEnvironment(duplicateEnvPath);

        assert.ok(mockState.set.notCalled);
    });

    test('removeUvEnvironment should remove environment from list', async () => {
        const existingEnvs = ['/path/to/env1', '/path/to/env2'];
        const envToRemove = '/path/to/env1';
        mockState.get.withArgs(UV_ENVS_KEY).resolves(existingEnvs);

        await removeUvEnvironment(envToRemove);

        assert.ok(mockState.set.calledWith(UV_ENVS_KEY, ['/path/to/env2']));
    });

    test('clearUvEnvironments should set empty array', async () => {
        await clearUvEnvironments();

        assert.ok(mockState.set.calledWith(UV_ENVS_KEY, []));
    });

    test('clearVenvCache should clear UV environments along with other caches', async () => {
        await clearVenvCache();

        // Check that clear was called with the right keys including UV_ENVS_KEY
        const clearArgs = mockState.clear.getCall(0).args[0];
        assert.ok(clearArgs.includes(UV_ENVS_KEY));
    });
});
