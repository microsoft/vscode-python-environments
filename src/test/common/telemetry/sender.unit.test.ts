import assert from 'node:assert';
import * as sinon from 'sinon';
import { EventNames } from '../../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../../common/telemetry/sender';
import { vscMockTelemetryReporter } from '../../mocks/vsc/telemetryReporter';

suite('Telemetry sender', () => {
    let originalTestExecution: string | undefined;
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        originalTestExecution = process.env.VSC_PYTHON_CI_TEST;
        delete process.env.VSC_PYTHON_CI_TEST;
        sendTelemetryStub = sinon.stub(vscMockTelemetryReporter.prototype, 'sendTelemetryEvent');
    });

    teardown(() => {
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
});
