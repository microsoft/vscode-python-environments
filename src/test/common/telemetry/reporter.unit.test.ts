// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import type { Disposable, TelemetryLogger, TelemetrySender } from 'vscode';
import * as envApis from '../../../common/env.apis';
import * as logging from '../../../common/logging';
import {
    getSharedTelemetryProperties,
    getTelemetryReporter,
    registerTelemetryReporter,
    setSharedTelemetryProperty,
} from '../../../common/telemetry/reporter';
import { createDeferred } from '../../../common/utils/deferred';
import { vscMockTelemetryReporter } from '../../mocks/vsc/telemetryReporter';

suite('Telemetry reporter lifecycle', () => {
    let registrations: Disposable[];
    let automaticSenders: TelemetrySender[];
    let automaticLoggers: TelemetryLogger[];
    let createLogger: sinon.SinonStub;

    setup(() => {
        registrations = [];
        automaticSenders = [];
        automaticLoggers = [];
        createLogger = sinon.stub(envApis, 'createTelemetryLogger').callsFake((sender: TelemetrySender) => {
            const logger: TelemetryLogger = {
                isUsageEnabled: true,
                isErrorsEnabled: true,
                logUsage: sinon.spy(),
                logError: sinon.spy(),
                onDidChangeEnableStates: () => ({ dispose: () => undefined }),
                dispose: sinon.spy(),
            };
            automaticSenders.push(sender);
            automaticLoggers.push(logger);
            return logger;
        });
    });

    teardown(async () => {
        await Promise.all(registrations.map((registration) => registration.dispose()));
        sinon.restore();
    });

    function register(): Disposable {
        const registration = registerTelemetryReporter();
        registrations.push(registration);
        return registration;
    }

    test('does not create a reporter without an active registration', () => {
        assert.strictEqual(getTelemetryReporter(), undefined);
        sinon.assert.notCalled(createLogger);
    });

    test('reuses one lazy reporter until disposal', async () => {
        const registration = register();
        const first = getTelemetryReporter();
        assert.ok(first);
        assert.strictEqual(getTelemetryReporter(), first);
        sinon.assert.calledOnce(createLogger);
        const dispose = sinon.spy(vscMockTelemetryReporter.prototype, 'dispose');
        await registration.dispose();
        assert.strictEqual(dispose.callCount, 1);
        sinon.assert.calledOnce(automaticLoggers[0].dispose as sinon.SinonSpy);
        assert.strictEqual(getTelemetryReporter(), undefined);
        register();
        assert.ok(getTelemetryReporter());
        assert.notStrictEqual(getTelemetryReporter(), first);
        await registration.dispose();
        assert.strictEqual(dispose.callCount, 1, 'old cleanup must not dispose the next reporter');
    });

    test('copies shared properties and removes assignment context on disposal', async () => {
        const registration = register();
        setSharedTelemetryProperty('abexp.assignmentcontext', 'first;');
        const first = getSharedTelemetryProperties();
        setSharedTelemetryProperty('abexp.assignmentcontext', 'second;');
        assert.deepStrictEqual(first, { 'abexp.assignmentcontext': 'first;' });
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'second;' });
        await registration.dispose();
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
    });

    test('an obsolete registration cannot dispose the current reporter or clear its context', async () => {
        const obsolete = register();
        register();
        const current = getTelemetryReporter();
        assert.ok(current);
        const dispose = sinon.spy(vscMockTelemetryReporter.prototype, 'dispose');
        setSharedTelemetryProperty('abexp.assignmentcontext', 'current;');
        await obsolete.dispose();
        assert.strictEqual(getTelemetryReporter(), current);
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'current;' });
        sinon.assert.notCalled(dispose);
    });

    test('blocks creation during disposal and preserves a newer registration when flushing finishes', async () => {
        const flush = createDeferred<void>();
        sinon.stub(vscMockTelemetryReporter.prototype, 'dispose').returns(flush.promise);
        const oldRegistration = register();
        const old = getTelemetryReporter();
        assert.ok(old);
        const closing = oldRegistration.dispose();
        assert.strictEqual(getTelemetryReporter(), undefined);

        register();
        const current = getTelemetryReporter();
        assert.ok(current);
        assert.notStrictEqual(current, old);
        setSharedTelemetryProperty('abexp.assignmentcontext', 'current;');
        flush.resolve();
        await closing;
        assert.strictEqual(getTelemetryReporter(), current);
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'current;' });
    });

    test('disables duplicate SDK exception collection and preserves automatic-error common properties', () => {
        register();
        const reporter = getTelemetryReporter();
        assert.ok(reporter instanceof vscMockTelemetryReporter);
        assert.strictEqual(reporter.initializationOptions?.ignoreUnhandledErrors, true);
        const options = createLogger.firstCall.args[1];
        assert.strictEqual(options.ignoreUnhandledErrors, undefined, 'the owned logger handles automatic exceptions');
        assert.strictEqual(options.additionalCommonProperties['common.os'], process.platform);
        assert.strictEqual(options.additionalCommonProperties['common.nodeArch'], process.arch);
        assert.match(options.additionalCommonProperties['common.telemetryclientversion'], /^\d+\.\d+\.\d+/);
    });

    test('automatic exceptions preserve event names, measurements, and per-event assignment snapshots', () => {
        register();
        const reporter = getTelemetryReporter();
        assert.ok(reporter);
        const send = sinon.spy(vscMockTelemetryReporter.prototype, 'sendDangerousTelemetryEvent');
        const error = new Error('already cleaned by VS Code');
        const properties = { 'common.extname': 'test', 'abexp.assignmentcontext': 'wrong;' };
        setSharedTelemetryProperty('abexp.assignmentcontext', 'control;');
        automaticSenders[0].sendErrorData(error, { properties, measurements: { duration: 12 } });
        assert.deepStrictEqual(send.firstCall.args, ['unhandlederror', {
            'common.extname': 'test',
            'abexp.assignmentcontext': 'control;',
            name: error.name,
            message: error.message,
            stack: error.stack,
        }, { duration: 12 }]);
        setSharedTelemetryProperty('abexp.assignmentcontext', 'treatment;');
        automaticSenders[0].sendErrorData(error);
        assert.strictEqual(send.firstCall.args[1]?.['abexp.assignmentcontext'], 'control;');
        assert.strictEqual(send.secondCall.args[1]?.['abexp.assignmentcontext'], 'treatment;');
        assert.strictEqual(properties['abexp.assignmentcontext'], 'wrong;', 'input properties are not mutated');
        setSharedTelemetryProperty('abexp.assignmentcontext', undefined);
        automaticSenders[0].sendErrorData(error);
        assert.ok(!Object.prototype.hasOwnProperty.call(send.thirdCall.args[1], 'abexp.assignmentcontext'));
    });

    test('automatic exceptions independently enforce error consent', () => {
        register();
        const reporter = getTelemetryReporter();
        assert.ok(reporter);
        const send = sinon.spy(vscMockTelemetryReporter.prototype, 'sendDangerousTelemetryEvent');
        for (const level of ['off', 'crash'] as const) {
            reporter.telemetryLevel = level;
            automaticSenders[0].sendErrorData(new Error('disabled'));
        }
        sinon.assert.notCalled(send);
        reporter.telemetryLevel = 'error';
        automaticSenders[0].sendErrorData(new Error('errors allowed'));
        sinon.assert.calledOnce(send);
        reporter.telemetryLevel = 'all';
        automaticSenders[0].sendErrorData(new Error('all allowed'));
        sinon.assert.calledTwice(send);
    });

    test('automatic error callbacks cannot send after disposal or through an obsolete reporter', async () => {
        const first = register();
        assert.ok(getTelemetryReporter());
        const oldSender = automaticSenders[0];
        const send = sinon.spy(vscMockTelemetryReporter.prototype, 'sendDangerousTelemetryEvent');
        await first.dispose();
        oldSender.sendErrorData(new Error('after disposal'));
        assert.strictEqual(getTelemetryReporter(), undefined);
        register();
        assert.ok(getTelemetryReporter());
        oldSender.sendErrorData(new Error('after replacement'));
        sinon.assert.notCalled(send);
        automaticSenders[1].sendErrorData(new Error('current'));
        sinon.assert.calledOnce(send);
    });

    test('automatic error transport failures are contained and logged', () => {
        register();
        assert.ok(getTelemetryReporter());
        sinon.stub(vscMockTelemetryReporter.prototype, 'sendDangerousTelemetryEvent').throws(new Error('unavailable'));
        const log = sinon.stub(logging, 'traceError');
        assert.doesNotThrow(() => automaticSenders[0].sendErrorData(new Error('original')));
        sinon.assert.calledOnce(log);
    });

    test('failed automatic-error registration disposes its reporter and permits a fresh attempt', async () => {
        register();
        createLogger.onFirstCall().throws(new Error('logger unavailable'));
        const dispose = sinon.spy(vscMockTelemetryReporter.prototype, 'dispose');
        assert.throws(() => getTelemetryReporter(), /logger unavailable/);
        sinon.assert.calledOnce(dispose);
        const reporter = getTelemetryReporter();
        assert.ok(reporter);
        assert.notStrictEqual(reporter, dispose.firstCall.thisValue);
    });
});
