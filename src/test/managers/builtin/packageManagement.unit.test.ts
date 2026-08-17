import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { LogOutputChannel, Uri } from 'vscode';
import { PackageManager, PythonEnvironment } from '../../../api';
import * as helpers from '../../../managers/builtin/helpers';
import {
    managePackages,
    refreshPipDirectPackageNames,
    refreshPipPackages,
} from '../../../managers/builtin/utils';
import { createMockLogOutputChannel, setupNonThenable } from '../../mocks/helper';

suite('Pip package management', () => {
    let environment: typeMoq.IMock<PythonEnvironment>;
    let manager: typeMoq.IMock<PackageManager>;
    let log: LogOutputChannel;
    let runUvStub: sinon.SinonStub;
    let environmentTarget: string;
    let baseInterpreter: string;

    setup(() => {
        environmentTarget = Uri.file(path.join('test-data', 'pipenv-environment')).fsPath;
        baseInterpreter = Uri.file(path.join('test-data', 'uv', 'python')).fsPath;

        environment = typeMoq.Mock.ofType<PythonEnvironment>();
        environment.setup((env) => env.version).returns(() => '3.13.0');
        environment.setup((env) => env.environmentPath).returns(() => Uri.file(environmentTarget));
        environment.setup((env) => env.execInfo).returns(() => ({ run: { executable: baseInterpreter } }));
        setupNonThenable(environment);

        log = createMockLogOutputChannel();
        manager = typeMoq.Mock.ofType<PackageManager>();
        manager.setup((packageManager) => packageManager.log).returns(() => log);
        setupNonThenable(manager);

        sinon.stub(helpers, 'shouldUseUv').resolves(true);
        runUvStub = sinon.stub(helpers, 'runUV').resolves('');
    });

    teardown(() => {
        sinon.restore();
    });

    test('uses the environment path when listing packages with uv', async () => {
        runUvStub.resolves('[]');

        const packages = await refreshPipPackages(environment.object, log);

        assert.deepStrictEqual(packages, []);
        sinon.assert.calledWithExactly(
            runUvStub,
            ['pip', 'list', '--python', environmentTarget, '--format=json'],
            undefined,
            log,
            undefined,
            30_000,
        );
        assert.ok(!runUvStub.calledWith(sinon.match.array.contains([baseInterpreter])));
    });

    test('uses the environment path when finding direct packages with uv', async () => {
        await refreshPipDirectPackageNames(environment.object, log);

        sinon.assert.calledWithExactly(
            runUvStub,
            ['pip', 'tree', '--python', environmentTarget, '--depth=0'],
            undefined,
            log,
            undefined,
            30_000,
        );
        assert.ok(!runUvStub.calledWith(sinon.match.array.contains([baseInterpreter])));
    });

    test('uses the environment path when installing and uninstalling packages with uv', async () => {
        await managePackages(
            environment.object,
            { install: ['absl-py'], uninstall: ['setuptools'] },
            manager.object,
        );

        sinon.assert.calledTwice(runUvStub);
        sinon.assert.calledWithExactly(
            runUvStub.firstCall,
            ['pip', 'uninstall', '--python', environmentTarget, 'setuptools'],
            undefined,
            log,
            undefined,
        );
        sinon.assert.calledWithExactly(
            runUvStub.secondCall,
            ['pip', 'install', '--python', environmentTarget, 'absl-py'],
            undefined,
            log,
            undefined,
        );
        assert.ok(!runUvStub.calledWith(sinon.match.array.contains([baseInterpreter])));
    });
});
