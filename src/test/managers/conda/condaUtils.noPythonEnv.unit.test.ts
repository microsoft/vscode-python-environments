import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, WorkspaceConfiguration } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import * as workspaceApis from '../../../common/workspace.apis';
import { NativePythonEnvironmentKind, NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { isCondaEnvWithoutPython, resolveCondaPath } from '../../../managers/conda/condaUtils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('Conda Utils - environment without Python', () => {
    let captured: PythonEnvironmentInfo | undefined;
    let api: PythonEnvironmentApi;
    let log: LogOutputChannel;

    setup(() => {
        captured = undefined;

        const config = { get: sinon.stub() };
        config.get.withArgs('condaPath').returns('conda');
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python')
            .returns(config as unknown as WorkspaceConfiguration);

        api = {
            createPythonEnvironmentItem: (info: PythonEnvironmentInfo) => {
                captured = info;
                return createMockPythonEnvironment({
                    name: info.name,
                    envPath: info.displayPath,
                    version: info.version,
                });
            },
        } as unknown as PythonEnvironmentApi;

        log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as unknown as LogOutputChannel;
    });

    teardown(() => {
        sinon.restore();
    });

    test('reports an empty version rather than a placeholder that is not a version', async () => {
        // A conda prefix used purely as a toolchain (`conda create -n cuda cuda-toolkit`) has
        // no interpreter. `version` is part of the public API and consumers parse it as a PEP
        // 440 version, so "unknown" has to be the empty string: `ms-python.python` throws on
        // any other unparseable value, and the throw takes down the whole batch of
        // environments being published, not just this one.
        const nativeFinder = {
            resolve: sinon.stub().resolves({
                kind: NativePythonEnvironmentKind.conda,
                name: 'cuda',
                prefix: '/miniconda3/envs/cuda',
            }),
        } as unknown as NativePythonFinder;

        const result = await resolveCondaPath(
            '/miniconda3/envs/cuda',
            nativeFinder,
            api,
            log,
            {} as EnvironmentManager,
        );

        assert.ok(result, 'the environment should still be discovered');
        assert.ok(captured, 'createPythonEnvironmentItem should have been called');
        assert.strictEqual(captured.version, '');
        assert.ok(isCondaEnvWithoutPython(result), 'the environment should be recognized as having no Python');

        // The marker belongs in the display strings, which are shown but never parsed.
        assert.ok(captured.displayName?.includes('(no-python)'), 'display name should still mark the environment');
    });
});
