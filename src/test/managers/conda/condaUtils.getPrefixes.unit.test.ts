import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { WorkspaceConfiguration } from 'vscode';
import * as childProcessApis from '../../../common/childProcess.apis';
import * as persistentState from '../../../common/persistentState';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    clearCondaCache,
    CONDA_PREFIXES_KEY,
    getPrefixes,
} from '../../../managers/conda/condaUtils';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('Conda Utils - getPrefixes', () => {
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let spawnStub: sinon.SinonStub;

    setup(async () => {
        await clearCondaCache();

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(mockState);

        const config = { get: sinon.stub() };
        config.get.withArgs('condaPath').returns('conda');
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python')
            .returns(config as unknown as WorkspaceConfiguration);
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');
    });

    teardown(() => {
        sinon.restore();
    });

    test('refreshes an empty persisted cache with conda info', async () => {
        const envsDir = path.join(os.tmpdir(), 'conda-envs');
        mockState.get.withArgs(CONDA_PREFIXES_KEY).resolves([]);

        const mockProcess = new MockChildProcess('conda', ['info', '--json']);
        spawnStub.returns(mockProcess);

        const resultPromise = getPrefixes();
        setImmediate(() => {
            mockProcess.stdout?.emit('data', Buffer.from(JSON.stringify({ envs_dirs: [envsDir] })));
            mockProcess.emit('exit', 0, null);
            mockProcess.emit('close', 0, null);
        });

        assert.deepStrictEqual(await resultPromise, [envsDir]);
        assert.ok(spawnStub.calledOnceWithExactly('conda', ['info', '--json'], { shell: true }));
        assert.ok(mockState.set.calledOnceWithExactly(CONDA_PREFIXES_KEY, [envsDir]));
    });

    test('retries after conda returns an empty prefix list', async () => {
        const envsDir = path.join(os.tmpdir(), 'recovered-conda-envs');
        mockState.get.withArgs(CONDA_PREFIXES_KEY).resolves(undefined);

        const outputs = [{ envs_dirs: [] }, { envs_dirs: [envsDir] }];
        spawnStub.callsFake(() => {
            const mockProcess = new MockChildProcess('conda', ['info', '--json']);
            const output = outputs.shift();
            setImmediate(() => {
                mockProcess.stdout?.emit('data', Buffer.from(JSON.stringify(output)));
                mockProcess.emit('exit', 0, null);
                mockProcess.emit('close', 0, null);
            });
            return mockProcess;
        });

        assert.deepStrictEqual(await getPrefixes(), []);
        assert.ok(mockState.set.notCalled);

        assert.deepStrictEqual(await getPrefixes(), [envsDir]);
        assert.strictEqual(spawnStub.callCount, 2);
        assert.ok(mockState.set.calledOnceWithExactly(CONDA_PREFIXES_KEY, [envsDir]));
    });
});
