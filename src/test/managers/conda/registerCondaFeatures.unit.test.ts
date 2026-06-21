/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as pythonApi from '../../../features/pythonApi';
import { PythonProjectManager } from '../../../internal.api';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import * as condaSourcingUtils from '../../../managers/conda/condaSourcingUtils';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { registerCondaFeatures } from '../../../managers/conda/main';

/**
 * Tests for the unconditional, lazy registration entrypoint.
 *
 * The lazy-registration contract is:
 *  1. Conda manager is ALWAYS registered (so it shows up in the picker), regardless of
 *     whether the conda CLI exists on the machine.
 *  2. registerCondaFeatures does NO PET / sourcing-status work at activation time —
 *     that cost is deferred to CondaEnvManager.initialize() on first use.
 *  3. Both the env manager and the package manager are pushed onto disposables and
 *     registered with the api.
 */
suite('registerCondaFeatures - unconditional lazy registration', () => {
    let getCondaStub: sinon.SinonStub;
    let getCondaPathSettingStub: sinon.SinonStub;
    let refreshCondaEnvsStub: sinon.SinonStub;
    let constructSourcingStub: sinon.SinonStub;
    let getPythonApiStub: sinon.SinonStub;
    let registerEnvManagerStub: sinon.SinonStub;
    let registerPackageManagerStub: sinon.SinonStub;

    setup(() => {
        // Stubs on every discovery side-effect: if any of these fire, the test fails
        // because activation is no longer lazy.
        getCondaStub = sinon.stub(condaUtils, 'getConda');
        getCondaPathSettingStub = sinon.stub(condaUtils, 'getCondaPathSetting').returns(undefined);
        refreshCondaEnvsStub = sinon.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        constructSourcingStub = sinon.stub(condaSourcingUtils, 'constructCondaSourcingStatus');

        registerEnvManagerStub = sinon.stub().returns({ dispose: sinon.stub() });
        registerPackageManagerStub = sinon.stub().returns({ dispose: sinon.stub() });
        const api = {
            registerEnvironmentManager: registerEnvManagerStub,
            registerPackageManager: registerPackageManagerStub,
        } as any as PythonEnvironmentApi;
        getPythonApiStub = sinon.stub(pythonApi, 'getPythonApi').resolves(api);

        sinon.stub(logging, 'traceInfo');
        sinon.stub(logging, 'traceError');
    });

    teardown(() => {
        sinon.restore();
    });

    const log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any as LogOutputChannel;
    const nativeFinder = {} as NativePythonFinder;
    const projectManager = {} as PythonProjectManager;

    test('registers env manager and package manager unconditionally', async () => {
        const disposables: Disposable[] = [];

        await registerCondaFeatures(nativeFinder, disposables, log, projectManager);

        assert.strictEqual(getPythonApiStub.callCount, 1, 'should fetch the python api');
        assert.strictEqual(registerEnvManagerStub.callCount, 1, 'env manager must be registered');
        assert.strictEqual(registerPackageManagerStub.callCount, 1, 'package manager must be registered');
        // env manager + package manager + their two registration disposables
        assert.strictEqual(disposables.length, 4, 'four disposables expected');
    });

    test('does NOT call getConda / refreshCondaEnvs / constructCondaSourcingStatus at registration', async () => {
        await registerCondaFeatures(nativeFinder, [], log, projectManager);

        // These are the hot-path / PET-triggering calls that the previous (non-lazy)
        // implementation made during activation. Their absence is the whole point of
        // the lazy-registration change.
        assert.strictEqual(getCondaStub.callCount, 0, 'getConda must not be invoked at registration');
        assert.strictEqual(refreshCondaEnvsStub.callCount, 0, 'refreshCondaEnvs must not be invoked at registration');
        assert.strictEqual(
            constructSourcingStub.callCount,
            0,
            'constructCondaSourcingStatus must not be invoked at registration',
        );
        // We also don't inspect the conda path setting at registration time.
        assert.strictEqual(getCondaPathSettingStub.callCount, 0);
    });

    test('registers even when conda would not be found (no early-return on missing tool)', async () => {
        // Even if getConda would throw, registration must still succeed. We don't actually
        // call it during registerCondaFeatures, but we configure the stub to reject so a
        // regression that re-introduces the call would also fail this test.
        getCondaStub.rejects(new Error('Conda not found'));
        const disposables: Disposable[] = [];

        await registerCondaFeatures(nativeFinder, disposables, log, projectManager);

        assert.strictEqual(registerEnvManagerStub.callCount, 1);
        assert.strictEqual(registerPackageManagerStub.callCount, 1);
        assert.strictEqual(disposables.length, 4);
    });
});
