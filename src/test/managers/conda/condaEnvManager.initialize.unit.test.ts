/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import { PythonProjectManager } from '../../../internal.api';
import * as commonUtils from '../../../managers/common/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaSourcingUtils from '../../../managers/conda/condaSourcingUtils';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

/**
 * Tests for the lazy-registration flow on CondaEnvManager.initialize().
 * Covers:
 *  - success path (conda found locally / via settings / via PET)
 *  - tool_not_found path (no conda, notify missing-default)
 *  - error path (refresh throws)
 *  - telemetry emission for all three outcomes
 *  - sourcing information construction (and graceful handling of its failure)
 *  - idempotency of initialize()
 */
suite('CondaEnvManager.initialize - lazy registration flow', () => {
    let getCondaStub: sinon.SinonStub;
    let getCondaPathSettingStub: sinon.SinonStub;
    let refreshCondaEnvsStub: sinon.SinonStub;
    let constructSourcingStub: sinon.SinonStub;
    let notifyMissingStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;

    setup(() => {
        getCondaStub = sinon.stub(condaUtils, 'getConda');
        getCondaPathSettingStub = sinon.stub(condaUtils, 'getCondaPathSetting').returns(undefined);
        refreshCondaEnvsStub = sinon.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        sinon.stub(condaUtils, 'getCondaForGlobal').resolves(undefined);
        constructSourcingStub = sinon.stub(condaSourcingUtils, 'constructCondaSourcingStatus');
        notifyMissingStub = sinon.stub(commonUtils, 'notifyMissingManagerIfDefault').resolves();
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
        withProgressStub = sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            return await (task as any)({ report: sinon.stub() }, { isCancellationRequested: false } as any);
        });
        sinon.stub(logging, 'traceInfo');
        sinon.stub(logging, 'traceError');
    });

    teardown(() => {
        sinon.restore();
    });

    function createManager(opts?: {
        projectManager?: PythonProjectManager;
        api?: Partial<PythonEnvironmentApi>;
    }): CondaEnvManager {
        const api = {
            getPythonProjects: sinon.stub().returns([]),
            getPythonProject: sinon.stub().returns(undefined),
            ...opts?.api,
        } as any as PythonEnvironmentApi;
        return new CondaEnvManager(
            {} as NativePythonFinder,
            api,
            { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
            opts?.projectManager,
        );
    }

    function getLazyInitTelemetry(): any | undefined {
        const call = sendTelemetryStub
            .getCalls()
            .find((c) => c.args[0] === EventNames.MANAGER_LAZY_INIT);
        return call?.args[2];
    }

    test('success path: conda found via local lookup → toolSource=local, registers sourcing info', async () => {
        getCondaStub.resolves('/usr/bin/conda');
        const sourcing = { toString: () => 'sourcing' } as any;
        constructSourcingStub.resolves(sourcing);
        refreshCondaEnvsStub.resolves([makeEnv('base', '/opt/miniconda3', '3.11.0')]);

        const mgr = createManager();
        await mgr.initialize();

        // refresh was invoked (i.e. the work was actually done)
        assert.strictEqual(refreshCondaEnvsStub.callCount, 1, 'refreshCondaEnvs should be called once');
        // sourcing info is constructed using the resolved conda path
        assert.strictEqual(constructSourcingStub.callCount, 1);
        assert.strictEqual(constructSourcingStub.firstCall.args[0], '/usr/bin/conda');
        assert.strictEqual(mgr.sourcingInformation, sourcing);
        // missing-default notification is NOT shown when conda was found
        assert.strictEqual(notifyMissingStub.callCount, 0);

        const props = getLazyInitTelemetry();
        assert.deepStrictEqual(
            { managerName: props.managerName, result: props.result, envCount: props.envCount, toolSource: props.toolSource },
            { managerName: 'conda', result: 'success', envCount: 1, toolSource: 'local' },
        );
    });

    test('success path: conda from explicit setting → toolSource=settings', async () => {
        getCondaPathSettingStub.returns('/opt/conda/bin/conda');
        getCondaStub.resolves('/opt/conda/bin/conda');
        constructSourcingStub.resolves({ toString: () => '' } as any);

        const mgr = createManager();
        await mgr.initialize();

        const props = getLazyInitTelemetry();
        assert.strictEqual(props.toolSource, 'settings');
        assert.strictEqual(props.result, 'success');
    });

    test('success path: conda discovered via PET after refresh → toolSource=pet', async () => {
        // pre-refresh: getConda throws (not found locally)
        getCondaStub.onFirstCall().rejects(new Error('Conda not found'));
        // post-refresh: getConda resolves (PET persisted the path)
        getCondaStub.onSecondCall().resolves('/home/user/miniconda3/bin/conda');
        constructSourcingStub.resolves({ toString: () => '' } as any);

        const mgr = createManager();
        await mgr.initialize();

        // both pre- and post-refresh lookups happened
        assert.strictEqual(getCondaStub.callCount, 2, 'getConda should be called twice (pre/post refresh)');
        assert.strictEqual(constructSourcingStub.callCount, 1);

        const props = getLazyInitTelemetry();
        assert.strictEqual(props.result, 'success');
        assert.strictEqual(props.toolSource, 'pet');
        assert.strictEqual(notifyMissingStub.callCount, 0);
    });

    test('tool_not_found: conda not found pre- or post-refresh → notifies and emits tool_not_found telemetry', async () => {
        getCondaStub.rejects(new Error('Conda not found'));
        const projectManager = {} as PythonProjectManager;

        const mgr = createManager({ projectManager });
        await mgr.initialize();

        // refresh was still attempted (PET may have run, but didn't surface conda)
        assert.strictEqual(refreshCondaEnvsStub.callCount, 1);
        // sourcing info is NOT constructed when conda isn't found
        assert.strictEqual(constructSourcingStub.callCount, 0);
        assert.strictEqual(mgr.sourcingInformation, undefined);
        // missing-default notification was shown
        assert.strictEqual(notifyMissingStub.callCount, 1);
        assert.strictEqual(notifyMissingStub.firstCall.args[0], 'ms-python.python:conda');
        assert.strictEqual(notifyMissingStub.firstCall.args[1], projectManager);

        const props = getLazyInitTelemetry();
        assert.strictEqual(props.result, 'tool_not_found');
        assert.strictEqual(props.toolSource, 'none');
        assert.strictEqual(props.envCount, 0);
    });

    test('tool_not_found without projectManager: skips missing-default notification', async () => {
        getCondaStub.rejects(new Error('Conda not found'));

        const mgr = createManager(); // no projectManager
        await mgr.initialize();

        assert.strictEqual(notifyMissingStub.callCount, 0, 'no notify call when projectManager is absent');
        const props = getLazyInitTelemetry();
        assert.strictEqual(props.result, 'tool_not_found');
    });

    test('error path: refreshCondaEnvs throws → result=error, errorType is classified, no throw to caller', async () => {
        getCondaStub.resolves('/usr/bin/conda');
        refreshCondaEnvsStub.rejects(new Error('boom'));

        const mgr = createManager();
        await assert.doesNotReject(mgr.initialize(), 'initialize() must never throw to its caller');

        const props = getLazyInitTelemetry();
        assert.strictEqual(props.result, 'error');
        assert.ok(props.errorType, 'errorType should be set on error path');
        // sourcing info not populated when refresh fails
        assert.strictEqual(mgr.sourcingInformation, undefined);
    });

    test('error path: sourcing status failure is swallowed and does not flip result to error', async () => {
        getCondaStub.resolves('/usr/bin/conda');
        constructSourcingStub.rejects(new Error('sourcing-failed'));

        const mgr = createManager();
        await mgr.initialize();

        const props = getLazyInitTelemetry();
        // refresh succeeded, so overall result is still success
        assert.strictEqual(props.result, 'success');
        // but sourcingInformation is not set
        assert.strictEqual(mgr.sourcingInformation, undefined);
    });

    test('idempotency: concurrent initialize() calls share a single run', async () => {
        getCondaStub.resolves('/usr/bin/conda');
        constructSourcingStub.resolves({ toString: () => '' } as any);

        const mgr = createManager();
        await Promise.all([mgr.initialize(), mgr.initialize(), mgr.initialize()]);

        assert.strictEqual(refreshCondaEnvsStub.callCount, 1, 'refresh should run exactly once');
        // telemetry should fire exactly once across concurrent + sequential calls
        const lazyInitCalls = sendTelemetryStub
            .getCalls()
            .filter((c) => c.args[0] === EventNames.MANAGER_LAZY_INIT);
        assert.strictEqual(lazyInitCalls.length, 1);

        // a subsequent call after completion is also a no-op
        await mgr.initialize();
        assert.strictEqual(refreshCondaEnvsStub.callCount, 1);
    });

    test('no PET refresh is triggered before initialize(): construction alone does no work', () => {
        // Simply constructing the manager must not call into discovery.
        createManager();
        assert.strictEqual(getCondaStub.callCount, 0);
        assert.strictEqual(refreshCondaEnvsStub.callCount, 0);
        assert.strictEqual(constructSourcingStub.callCount, 0);
        assert.strictEqual(withProgressStub.callCount, 0);
    });
});
