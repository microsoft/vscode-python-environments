import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, WorkspaceConfiguration } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { PythonEnvironmentImpl } from '../../../internal.api';
import { NativePythonEnvironmentKind, NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import {
    checkForNoPythonCondaEnvironment,
    isCondaEnvWithoutPython,
    resolveCondaPath,
} from '../../../managers/conda/condaUtils';
import { createMockPythonEnvironment, makeMockCondaEnvironmentWithoutPython } from '../../mocks/pythonEnvironment';

suite('Conda Utils - environment without Python', () => {
    let captured: PythonEnvironmentInfo | undefined;
    let api: PythonEnvironmentApi;
    let log: LogOutputChannel;
    let showErrorMessageStub: sinon.SinonStub;

    setup(() => {
        captured = undefined;

        const config = { get: sinon.stub() };
        config.get.withArgs('condaPath').returns('conda');
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python')
            .returns(config as unknown as WorkspaceConfiguration);
        showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);

        api = {
            createPythonEnvironmentItem: (info: PythonEnvironmentInfo) => {
                captured = info;
                return new PythonEnvironmentImpl(
                    { id: `${info.name}-test`, managerId: 'ms-python.python:conda' },
                    info,
                );
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

    test('does not treat an interpreter with an unknown version as missing', async () => {
        // `''` is also the generic "version unknown" value: `defaultInterpreterPath` resolution
        // produces exactly this shape when PET returns an executable without a version. The
        // interpreter is real and runnable, so it must pass through `set()` untouched rather
        // than be routed into the install-Python flow.
        const environment = createMockPythonEnvironment({
            name: 'defaultInterpreterPath: ',
            envPath: '/miniconda3/envs/cuda/bin/python',
            sysPrefix: '/miniconda3/envs/cuda',
            version: '',
        });
        assert.strictEqual(environment.execInfo.run.executable, 'python');

        assert.strictEqual(isCondaEnvWithoutPython(environment), false);

        const checked = await checkForNoPythonCondaEnvironment(
            {} as NativePythonFinder,
            {} as EnvironmentManager,
            environment,
            api,
            log,
        );

        assert.strictEqual(checked, environment, 'the environment should be returned as-is');
        assert.ok(showErrorMessageStub.notCalled, 'no missing-Python prompt should be shown');
    });

    test('still offers to install Python for a prefix that has no interpreter', async () => {
        const environment = makeMockCondaEnvironmentWithoutPython('cuda', '/miniconda3/envs/cuda');

        assert.strictEqual(isCondaEnvWithoutPython(environment), true);

        const checked = await checkForNoPythonCondaEnvironment(
            {} as NativePythonFinder,
            {} as EnvironmentManager,
            environment,
            api,
            log,
        );

        assert.strictEqual(checked, undefined, 'declining the install should clear the selection');
        assert.ok(showErrorMessageStub.calledOnce, 'the missing-Python prompt should be shown');
    });
});
