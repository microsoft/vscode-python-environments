import assert from 'assert';
import * as sinon from 'sinon';
import * as persistentState from '../../../common/persistentState';
import { CONDA_WORKSPACE_KEY, getCondaForWorkspace } from '../../../managers/conda/condaUtils';

suite('Conda Utils - getCondaForWorkspace prioritization', () => {
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub };
    let getWorkspacePersistentStateStub: sinon.SinonStub;
    let originalCondaPrefix: string | undefined;

    setup(() => {
        originalCondaPrefix = process.env.CONDA_PREFIX;

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
        };
        getWorkspacePersistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        getWorkspacePersistentStateStub.resolves(mockState);
    });

    teardown(() => {
        if (originalCondaPrefix === undefined) {
            delete process.env.CONDA_PREFIX;
        } else {
            process.env.CONDA_PREFIX = originalCondaPrefix;
        }
        sinon.restore();
    });

    test('Persisted selection takes priority over CONDA_PREFIX', async () => {
        const workspacePath = '/home/user/project';
        const userSelectedEnv = '/home/user/miniconda3/envs/myenv';
        process.env.CONDA_PREFIX = '/home/user/miniconda3';

        mockState.get.withArgs(CONDA_WORKSPACE_KEY).resolves({
            [workspacePath]: userSelectedEnv,
        });

        const result = await getCondaForWorkspace(workspacePath);

        assert.strictEqual(result, userSelectedEnv);
    });

    test('CONDA_PREFIX is used as fallback when no persisted selection exists', async () => {
        const workspacePath = '/home/user/project';
        const condaBase = '/home/user/miniconda3';
        process.env.CONDA_PREFIX = condaBase;

        mockState.get.withArgs(CONDA_WORKSPACE_KEY).resolves(undefined);

        const result = await getCondaForWorkspace(workspacePath);

        assert.strictEqual(result, condaBase);
    });

    test('CONDA_PREFIX is used when persisted data exists but not for this workspace', async () => {
        const workspacePath = '/home/user/project';
        const condaBase = '/home/user/miniconda3';
        process.env.CONDA_PREFIX = condaBase;

        mockState.get.withArgs(CONDA_WORKSPACE_KEY).resolves({
            '/home/user/other-project': '/home/user/miniconda3/envs/other',
        });

        const result = await getCondaForWorkspace(workspacePath);

        assert.strictEqual(result, condaBase);
    });

    test('Returns undefined when no persisted selection and no CONDA_PREFIX', async () => {
        delete process.env.CONDA_PREFIX;

        mockState.get.withArgs(CONDA_WORKSPACE_KEY).resolves(undefined);

        const result = await getCondaForWorkspace('/home/user/project');

        assert.strictEqual(result, undefined);
    });

    test('Returns persisted selection when CONDA_PREFIX is not set', async () => {
        const workspacePath = '/home/user/project';
        const userSelectedEnv = '/home/user/miniconda3/envs/myenv';
        delete process.env.CONDA_PREFIX;

        mockState.get.withArgs(CONDA_WORKSPACE_KEY).resolves({
            [workspacePath]: userSelectedEnv,
        });

        const result = await getCondaForWorkspace(workspacePath);

        assert.strictEqual(result, userSelectedEnv);
    });
});
