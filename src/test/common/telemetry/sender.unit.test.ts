import assert from 'node:assert';
import * as sinon from 'sinon';
import type { Disposable } from 'vscode';
import type { EnvironmentManager } from '../../../api';
import { EventNames } from '../../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../../common/telemetry/sender';
import * as logging from '../../../common/logging';
import {
    getTelemetryReporter,
    registerTelemetryReporter,
    setSharedTelemetryProperty,
} from '../../../common/telemetry/reporter';
import { createDeferred } from '../../../common/utils/deferred';
import { InternalEnvironmentManager } from '../../../managers/common/registeredManagers';
import { vscMockTelemetryReporter } from '../../mocks/vsc/telemetryReporter';

suite('Telemetry sender', () => {
    let originalTestExecution: string | undefined;
    let sendTelemetryStub: sinon.SinonStub;
    let registration: Disposable;

    setup(() => {
        originalTestExecution = process.env.VSC_PYTHON_CI_TEST;
        delete process.env.VSC_PYTHON_CI_TEST;
        registration = registerTelemetryReporter();
        sendTelemetryStub = sinon.stub(vscMockTelemetryReporter.prototype, 'sendTelemetryEvent');
    });

    teardown(async () => {
        await registration.dispose();
        sinon.restore();
        if (originalTestExecution === undefined) {
            delete process.env.VSC_PYTHON_CI_TEST;
        } else {
            process.env.VSC_PYTHON_CI_TEST = originalTestExecution;
        }
    });

    test('sends total and stage setup durations as measurements', () => {
        sendTelemetryEvent(
            EventNames.SETUP_HANG_DETECTED,
            { duration: 120_000, stageDuration: 45_000 },
            { failureStage: 'envSelection', globalScopeDeferred: 'deferred' },
        );

        assert.strictEqual(sendTelemetryStub.callCount, 1);
        assert.deepStrictEqual(sendTelemetryStub.firstCall.args, [
            EventNames.SETUP_HANG_DETECTED,
            { failureStage: 'envSelection', globalScopeDeferred: 'deferred' },
            { duration: 120_000, stageDuration: 45_000 },
        ]);
    });

    test('attaches current assignments to ordinary events without changing measurements', () => {
        setSharedTelemetryProperty('abexp.assignmentcontext', 'control;');
        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 25);
        const first = sendTelemetryStub.firstCall.args;
        const firstProperties = sendTelemetryStub.firstCall.args[1];
        assert.deepStrictEqual(first, [
            EventNames.EXTENSION_ACTIVATION_DURATION, { 'abexp.assignmentcontext': 'control;' }, { duration: 25 },
        ]);
        setSharedTelemetryProperty('abexp.assignmentcontext', 'treatment;');
        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 30);
        assert.strictEqual(firstProperties['abexp.assignmentcontext'], 'control;', 'sent events keep their snapshot');
        assert.strictEqual(sendTelemetryStub.secondCall.args[1]['abexp.assignmentcontext'], 'treatment;');
    });

    test('attaches assignments to error events as well as normal events', () => {
        const errors = sinon.stub(vscMockTelemetryReporter.prototype, 'sendTelemetryErrorEvent');
        setSharedTelemetryProperty('abexp.assignmentcontext', 'control;');
        const error = new Error('test failure');
        sendTelemetryEvent(EventNames.ENVIRONMENT_DISCOVERY, 5, {
            managerId: 'test', result: 'error', errorType: 'unknown',
        }, error);
        assert.strictEqual(errors.callCount, 1);
        const properties = errors.firstCall.args[1];
        assert.ok(properties);
        assert.strictEqual(properties['abexp.assignmentcontext'], 'control;');
        assert.strictEqual(properties.errorName, 'Error');
        assert.deepStrictEqual(errors.firstCall.args[2], { duration: 5 });
        sinon.assert.notCalled(sendTelemetryStub);
    });

    test('shared attribution wins over colliding per-event properties', () => {
        setSharedTelemetryProperty('abexp.assignmentcontext', 'sdk-owned;');
        const properties = { managerId: 'test', 'abexp.assignmentcontext': 'wrong;' };
        sendTelemetryEvent(EventNames.ENVIRONMENT_MANAGER_REGISTERED, undefined, properties);
        assert.strictEqual(sendTelemetryStub.firstCall.args[1]['abexp.assignmentcontext'], 'sdk-owned;');
        assert.strictEqual(properties['abexp.assignmentcontext'], 'wrong;', 'caller properties are not mutated');
    });

    test('cleared attribution is absent from subsequent events', () => {
        setSharedTelemetryProperty('abexp.assignmentcontext', 'old;');
        setSharedTelemetryProperty('abexp.assignmentcontext', undefined);
        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 1);
        assert.deepStrictEqual(sendTelemetryStub.firstCall.args[1], {});
    });

    test('test execution does not construct or send through the reporter', () => {
        process.env.VSC_PYTHON_CI_TEST = '1';
        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 1);
        sinon.assert.notCalled(sendTelemetryStub);
    });

    test('a reporter failure is logged without breaking the feature sending telemetry', () => {
        const log = sinon.stub(logging, 'traceError');
        sendTelemetryStub.throws(new Error('reporter unavailable'));
        assert.doesNotThrow(() => sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 1));
        sinon.assert.calledOnce(log);
    });

    test('drops normal and error events after disposal without creating another reporter', async () => {
        const errors = sinon.stub(vscMockTelemetryReporter.prototype, 'sendTelemetryErrorEvent');
        const old = getTelemetryReporter();
        assert.ok(old);
        const dispose = sinon.spy(vscMockTelemetryReporter.prototype, 'dispose');
        await registration.dispose();

        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 1);
        sendTelemetryEvent(
            EventNames.ENVIRONMENT_DISCOVERY, 1,
            { managerId: 'test', result: 'error' }, new Error('late failure'),
        );

        sinon.assert.notCalled(sendTelemetryStub);
        sinon.assert.notCalled(errors);
        sinon.assert.calledOnce(dispose);
        assert.strictEqual(getTelemetryReporter(), undefined);
    });

    test('a delayed manager refresh completes without recreating telemetry after shutdown', async () => {
        const completion = createDeferred<void>();
        const manager: EnvironmentManager = {
            name: 'test',
            preferredPackageManagerId: 'test',
            refresh: () => completion.promise,
            getEnvironments: async () => [],
            get: async () => undefined,
            set: async () => undefined,
            resolve: async () => undefined,
        };
        const registered = new InternalEnvironmentManager('test:delayed', manager);
        const old = getTelemetryReporter();
        assert.ok(old);
        const refresh = registered.refresh(undefined);
        await registration.dispose();
        completion.resolve();
        await refresh;

        sinon.assert.notCalled(sendTelemetryStub);
        assert.strictEqual(getTelemetryReporter(), undefined);
    });

    test('a new registration restores sending with fresh attribution', async () => {
        const old = registration;
        const oldReporter = getTelemetryReporter();
        await old.dispose();
        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 1);
        sinon.assert.notCalled(sendTelemetryStub);

        registration = registerTelemetryReporter();
        setSharedTelemetryProperty('abexp.assignmentcontext', 'new;');
        await old.dispose();
        sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, 2);

        sinon.assert.calledOnce(sendTelemetryStub);
        assert.notStrictEqual(sendTelemetryStub.firstCall.thisValue, oldReporter);
        assert.strictEqual(sendTelemetryStub.firstCall.args[1]['abexp.assignmentcontext'], 'new;');
    });
});
