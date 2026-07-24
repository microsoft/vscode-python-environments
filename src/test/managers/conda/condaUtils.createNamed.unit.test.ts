import assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, Progress, Uri, WorkspaceConfiguration } from 'vscode';
import {
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../../api';
import * as childProcessApis from '../../../common/childProcess.apis';
import * as persistentState from '../../../common/persistentState';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    clearCondaCache,
    CONDA_PATH_KEY,
    CONDA_PREFIXES_KEY,
    createNamedCondaEnvironment,
} from '../../../managers/conda/condaUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('Conda Utils - createNamedCondaEnvironment', () => {
    let tempRoot: string;
    let condaPath: string;
    let envPrefix: string;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let spawnStub: sinon.SinonStub;

    setup(async () => {
        await clearCondaCache();
        tempRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'vscode-python-envs-conda-'));
        condaPath = path.join(tempRoot, os.platform() === 'win32' ? 'conda.exe' : 'conda');
        envPrefix = path.join(tempRoot, 'returned-prefix');
        await fse.outputFile(condaPath, '');
        await fse.outputJson(path.join(envPrefix, 'conda-meta', 'python-3.12.0-0.json'), { version: '3.12.0' });

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        mockState.get.withArgs(CONDA_PATH_KEY).resolves(condaPath);
        mockState.get.withArgs(CONDA_PREFIXES_KEY).resolves([]);
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(mockState);

        const config = { get: sinon.stub() };
        config.get.withArgs('condaPath').returns(condaPath);
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python')
            .returns(config as unknown as WorkspaceConfiguration);
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('test-env');
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            return await task(
                { report: sinon.stub() } as unknown as Progress<{ message?: string; increment?: number }>,
                { isCancellationRequested: false } as CancellationToken,
            );
        });
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');
    });

    teardown(async () => {
        sinon.restore();
        await fse.remove(tempRoot);
    });

    const createResults: { description: string; output: (prefix: string) => object }[] = [
        { description: 'current top-level prefix', output: (prefix) => ({ success: true, prefix }) },
        {
            description: 'legacy actions.PREFIX',
            output: (prefix) => ({ success: true, actions: { PREFIX: prefix } }),
        },
    ];
    const createArgs = ['create', '--yes', '--quiet', '--json', '--name', 'test-env', 'python=3.12'];
    createResults.forEach(({ description, output }) => {
        test(`uses the ${description} returned by conda create --json`, async () => {
            const mockProcess = new MockChildProcess(condaPath, createArgs);
            spawnStub.callsFake(() => {
                setImmediate(() => {
                    mockProcess.stdout?.emit('data', Buffer.from(JSON.stringify(output(envPrefix))));
                    mockProcess.emit('exit', 0, null);
                    mockProcess.emit('close', 0, null);
                });
                return mockProcess;
            });

            const createdEnvironment = {} as PythonEnvironment;
            const createEnvironmentItem = sinon.stub().returns(createdEnvironment);
            const api = { createPythonEnvironmentItem: createEnvironmentItem } as unknown as PythonEnvironmentApi;
            const manager = {} as EnvironmentManager;

            const resultPromise = createNamedCondaEnvironment(
                api,
                createMockLogOutputChannel(),
                manager,
                'test-env',
                '3.12',
            );

            assert.strictEqual(await resultPromise, createdEnvironment);
            assert.deepStrictEqual(spawnStub.firstCall.args[1], createArgs);
            assert.ok(!mockState.get.calledWith(CONDA_PREFIXES_KEY));

            const info = createEnvironmentItem.firstCall.args[0] as PythonEnvironmentInfo;
            assert.strictEqual(info.environmentPath.fsPath, Uri.file(envPrefix).fsPath);
        });
    });
});
