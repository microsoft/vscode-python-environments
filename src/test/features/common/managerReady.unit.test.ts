import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, EventEmitter } from 'vscode';
import * as extensionApis from '../../../common/extension.apis';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import * as windowApis from '../../../common/window.apis';
import {
    MANAGER_READY_TIMEOUT_MS,
    _resetManagerReadyForTesting,
    createManagerReady,
    waitForEnvManagerId,
    waitForPkgManagerId,
    withManagerTimeout,
} from '../../../features/common/managerReady';
import * as settingHelpers from '../../../features/settings/settingHelpers';
import {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagers,
    InternalEnvironmentManager,
    InternalPackageManager,
    PythonProjectManager,
} from '../../../internal.api';

suite('withManagerTimeout', () => {
    let clock: sinon.SinonFakeTimers;
    let traceWarnStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        clock = sinon.useFakeTimers();
        traceWarnStub = sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceError');
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
        // Stub dependencies used by promptInstallExtensionIfMissing (called on timeout)
        sinon.stub(extensionApis, 'getExtension').returns(undefined);
        sinon.stub(windowApis, 'showErrorMessage').returns(Promise.resolve(undefined));
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
    });

    test('deferred never resolves → timeout fires, logs warning, sends telemetry', async () => {
        const deferred = createDeferred<void>();
        const promise = withManagerTimeout(deferred, 'test-ext:venv', 'environment');

        // Advance past the timeout
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0); // flush microtasks

        await promise;

        // Warning was logged with manager ID
        assert.ok(traceWarnStub.calledOnce, 'traceWarn should be called once');
        assert.ok(traceWarnStub.firstCall.args[0].includes('test-ext:venv'), 'warning should contain the manager ID');

        // Telemetry was sent
        assert.ok(sendTelemetryStub.calledOnce, 'sendTelemetryEvent should be called once');
        const [eventName, , properties] = sendTelemetryStub.firstCall.args;
        assert.strictEqual(eventName, EventNames.MANAGER_READY_TIMEOUT);
        assert.strictEqual(properties.managerId, 'test-ext:venv');
        assert.strictEqual(properties.managerKind, 'environment');
    });

    test('deferred resolves before timeout → no warning, no telemetry', async () => {
        const deferred = createDeferred<void>();
        const promise = withManagerTimeout(deferred, 'test-ext:conda', 'environment');

        // Resolve before timeout
        deferred.resolve();
        await clock.tickAsync(0);

        await promise;

        // Advance past the timeout to confirm it was cleared
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);

        assert.ok(traceWarnStub.notCalled, 'traceWarn should not be called');
        assert.ok(sendTelemetryStub.notCalled, 'sendTelemetryEvent should not be called');
    });

    test('timeout resolves (not rejects) the deferred', async () => {
        const deferred = createDeferred<void>();
        const promise = withManagerTimeout(deferred, 'test-ext:missing', 'environment');

        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);

        // This must resolve — if it rejects, the test fails
        await promise;

        assert.ok(deferred.resolved, 'deferred should be resolved, not rejected');
        assert.ok(!deferred.rejected, 'deferred should not be rejected');
    });

    test('already-completed deferred returns immediately without timeout', async () => {
        const deferred = createDeferred<void>();
        deferred.resolve();

        const promise = withManagerTimeout(deferred, 'test-ext:venv', 'environment');
        await promise;

        // No timer was set, so nothing should fire
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);

        assert.ok(traceWarnStub.notCalled, 'traceWarn should not be called for completed deferred');
        assert.ok(sendTelemetryStub.notCalled, 'sendTelemetryEvent should not be called for completed deferred');
    });

    test('package manager kind is passed through to telemetry', async () => {
        const deferred = createDeferred<void>();
        const promise = withManagerTimeout(deferred, 'test-ext:pip', 'package');

        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);
        await promise;

        const [, , properties] = sendTelemetryStub.firstCall.args;
        assert.strictEqual(properties.managerId, 'test-ext:pip');
        assert.strictEqual(properties.managerKind, 'package');
    });
});

suite('ManagerReady - race condition handling', () => {
    let envManagerEmitter: EventEmitter<DidChangeEnvironmentManagerEventArgs>;
    let pkgManagerEmitter: EventEmitter<DidChangePackageManagerEventArgs>;
    let clock: sinon.SinonFakeTimers;
    let disposables: Disposable[];

    setup(() => {
        clock = sinon.useFakeTimers();
        disposables = [];

        _resetManagerReadyForTesting();

        envManagerEmitter = new EventEmitter<DidChangeEnvironmentManagerEventArgs>();
        pkgManagerEmitter = new EventEmitter<DidChangePackageManagerEventArgs>();

        // Stub logging and telemetry to keep test output clean
        sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceInfo');
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
        sinon.stub(windowApis, 'showErrorMessage').returns(Promise.resolve(undefined));
        sinon.stub(extensionApis, 'getExtension').returns({
            id: 'ms-python.python',
            isActive: true,
        } as unknown as ReturnType<typeof extensionApis.getExtension>);
        sinon.stub(settingHelpers, 'getDefaultEnvManagerSetting').returns('ms-python.python:venv');
        sinon.stub(settingHelpers, 'getDefaultPkgManagerSetting').returns('ms-python.python:pip');

        const mockEm = {
            onDidChangeEnvironmentManager: envManagerEmitter.event,
            onDidChangePackageManager: pkgManagerEmitter.event,
        } as unknown as EnvironmentManagers;

        const mockPm = {
            getProjects: () => [],
        } as unknown as PythonProjectManager;

        createManagerReady(mockEm, mockPm, disposables);
    });

    teardown(() => {
        clock.restore();
        disposables.forEach((d) => d.dispose());
        envManagerEmitter.dispose();
        pkgManagerEmitter.dispose();
        sinon.restore();
        _resetManagerReadyForTesting();
    });

    test('no install prompt when manager registers before timeout', async () => {
        const waitPromise = waitForEnvManagerId(['ms-python.python:venv']);
        // Flush microtasks so the internal await _deferred.promise completes
        // and the timeout/deferred is set up
        await clock.tickAsync(0);

        // Manager registers before timeout
        envManagerEmitter.fire({
            kind: 'registered',
            manager: { id: 'ms-python.python:venv' } as unknown as InternalEnvironmentManager,
        });

        await clock.tickAsync(0);
        await waitPromise;

        // Advance past timeout to ensure no late prompt
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);

        const showErrorStub = windowApis.showErrorMessage as sinon.SinonStub;
        assert.ok(!showErrorStub.called, 'should not prompt to install when manager registered successfully');
    });

    test('no install prompt on timeout when extension is installed but manager never registered', async () => {
        // Extension IS installed (getExtension returns it), but manager never fires registration event
        const waitPromise = waitForEnvManagerId(['ms-python.python:venv']);
        // Flush microtasks so internal await completes and timeout is armed
        await clock.tickAsync(0);

        // Advance past timeout — manager never registers
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);
        await waitPromise;

        // Should NOT prompt to install because getExtension finds the extension
        const showErrorStub = windowApis.showErrorMessage as sinon.SinonStub;
        assert.ok(!showErrorStub.called, 'should not prompt to install when extension is installed');

        // Should log a warning instead
        const traceWarnStub = logging.traceWarn as sinon.SinonStub;
        const warnAboutManager = traceWarnStub.getCalls().find(
            (c: sinon.SinonSpyCall) => typeof c.args[0] === 'string' && c.args[0].includes('never registered'),
        );
        assert.ok(warnAboutManager, 'should warn that manager never registered despite extension being installed');
    });

    test('install prompt shown on timeout only when extension is genuinely not installed', async () => {
        const getExtensionStub = extensionApis.getExtension as sinon.SinonStub;
        getExtensionStub.returns(undefined); // Extension not installed

        const waitPromise = waitForEnvManagerId(['ms-python.python:venv']);
        // Flush microtasks so internal await completes and timeout is armed
        await clock.tickAsync(0);

        // Advance past timeout — manager never registers
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);
        await waitPromise;

        // NOW the install prompt should appear (after 30s, not immediately)
        const showErrorStub = windowApis.showErrorMessage as sinon.SinonStub;
        assert.ok(showErrorStub.called, 'should prompt to install after timeout when extension is missing');
    });

    test('manager registered before wait resolves immediately without prompt', async () => {
        envManagerEmitter.fire({
            kind: 'registered',
            manager: { id: 'ms-python.python:venv' } as unknown as InternalEnvironmentManager,
        });

        await clock.tickAsync(0);

        // Wait should resolve immediately since the manager already registered
        const waitPromise = waitForEnvManagerId(['ms-python.python:venv']);
        await clock.tickAsync(0);
        await waitPromise;

        const showErrorStub = windowApis.showErrorMessage as sinon.SinonStub;
        assert.ok(!showErrorStub.called, 'should not prompt when manager already registered');
    });

    test('pkg manager wait resolves when registration event fires', async () => {
        const waitPromise = waitForPkgManagerId(['ms-python.python:pip']);

        pkgManagerEmitter.fire({
            kind: 'registered',
            manager: { id: 'ms-python.python:pip' } as unknown as InternalPackageManager,
        });

        await clock.tickAsync(0);
        await waitPromise;

        const showErrorStub = windowApis.showErrorMessage as sinon.SinonStub;
        assert.ok(!showErrorStub.called, 'should not prompt when pkg manager registered');
    });
});
