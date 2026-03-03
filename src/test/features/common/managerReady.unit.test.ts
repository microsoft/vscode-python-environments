import assert from 'assert';
import * as sinon from 'sinon';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import { MANAGER_READY_TIMEOUT_MS, withManagerTimeout } from '../../../features/common/managerReady';

suite('withManagerTimeout', () => {
    let clock: sinon.SinonFakeTimers;
    let traceWarnStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        clock = sinon.useFakeTimers();
        traceWarnStub = sinon.stub(logging, 'traceWarn');
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
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
