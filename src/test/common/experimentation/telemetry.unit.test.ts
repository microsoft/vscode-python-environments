// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import { ENVS_EXTENSION_ID } from '../../../common/constants';
import { ExperimentationTelemetry } from '../../../common/experimentation/telemetry';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import { getSharedTelemetryProperties, setSharedTelemetryProperty } from '../../../common/telemetry/reporter';
import * as sender from '../../../common/telemetry/sender';

suite('Experimentation telemetry adapter', () => {
    let active: boolean;
    let adapter: ExperimentationTelemetry;
    let send: sinon.SinonStub;
    let onCall: sinon.SinonSpy;
    let warn: sinon.SinonStub;

    setup(() => {
        active = true;
        send = sinon.stub(sender, 'sendTelemetryEvent');
        warn = sinon.stub(logging, 'traceWarn');
        onCall = sinon.spy();
        adapter = new ExperimentationTelemetry(() => active, onCall);
    });

    teardown(() => {
        setSharedTelemetryProperty('abexp.assignmentcontext', undefined);
        sinon.restore();
    });

    test('shares assignment context and clears it when the SDK has no assignments', () => {
        adapter.setSharedProperty('abexp.assignmentcontext', 'control;');
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'control;' });
        adapter.setSharedProperty('abexp.assignmentcontext', '');
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
    });

    test('forwards classified query names but not unrelated SDK properties', () => {
        adapter.postEvent('query-expfeature', new Map([
            ['ABExp.queriedFeature', 'vscode.generalFeature'],
            ['machineId', 'must-not-be-forwarded'],
            ['path', 'must-not-be-forwarded'],
        ]));
        sinon.assert.calledOnceWithExactly(send, EventNames.EXPERIMENTATION_QUERY, undefined, {
            'ABExp.queriedFeature': 'vscode.generalFeature',
        });
    });

    test('reports assignments and legacy outcomes independently using the environments identity', () => {
        for (const callType of ['legacy', 'assignments']) {
            adapter.postEvent('tas-call', new Map([
                ['callType', callType], ['outcome', 'Success'],
                ['extensionName', 'not-the-environments-extension'], ['assignmentContext', `${callType};`],
            ]));
        }
        assert.strictEqual(onCall.callCount, 2);
        assert.strictEqual(send.callCount, 2);
        assert.deepStrictEqual(send.secondCall.args, [EventNames.EXPERIMENTATION_TAS_CALL, undefined, {
            callType: 'assignments', outcome: 'Success', extensionName: ENVS_EXTENSION_ID,
            assignmentContext: 'assignments;',
        }]);
        assert.deepStrictEqual(
            getSharedTelemetryProperties(), {}, 'per-request context is not the merged SDK context',
        );
    });

    test('forwards only classified fetch failure categories', () => {
        for (const event of ['call-tas-error', 'call-assignments-error']) {
            adapter.postEvent(event, new Map([['ErrorType', 'NoResponse'], ['headers', 'private']]));
        }
        assert.deepStrictEqual(send.firstCall.args, ['call-tas-error', undefined, { ErrorType: 'NoResponse' }]);
        assert.deepStrictEqual(
            send.secondCall.args, ['call-assignments-error', undefined, { ErrorType: 'NoResponse' }],
        );
    });

    test('keeps diagnostic counts numeric and drops arbitrary extra properties', () => {
        adapter.postEvent('assignments-validation', new Map([
            ['FeatureVariableCount', '3'], ['AssignedVariantCount', '1'], ['DataVersion', '2'],
            ['AssignmentContext', 'a;'], ['request', 'private'],
        ]));
        sinon.assert.calledOnceWithExactly(send, EventNames.EXPERIMENTATION_ASSIGNMENTS_VALIDATION, {
            FeatureVariableCount: 3, AssignedVariantCount: 1,
        }, { DataVersion: '2', AssignmentContext: 'a;' });
    });

    test('does not forward invalid counters as measurements', () => {
        adapter.postEvent('assignments-validation', new Map([
            ['FeatureVariableCount', '-1'], ['AssignedVariantCount', 'not a number'],
        ]));
        assert.deepStrictEqual(send.firstCall.args[1], {});
    });

    test('drops unknown events, raw headers, and unsupported shared properties with a bounded warning', () => {
        adapter.postEvent('report-headers', new Map([['clientId', 'private']]));
        adapter.postEvent('report-headers', new Map([['clientId', 'private']]));
        adapter.setSharedProperty('unclassified', 'private');
        sinon.assert.notCalled(send);
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
        assert.strictEqual(warn.callCount, 2);
    });

    test('refuses malformed SDK outcomes and path-like query names', () => {
        adapter.postEvent('tas-call', new Map([['callType', 'unknown'], ['outcome', 'Success']]));
        adapter.postEvent('query-expfeature', new Map([['ABExp.queriedFeature', '/vscode/private/path']]));
        adapter.postEvent('call-tas-error', new Map([['ErrorType', 'Success']]));
        sinon.assert.notCalled(send);
        sinon.assert.notCalled(onCall);
    });

    test('late callbacks after consent revocation or disposal cannot restore attribution or send events', () => {
        active = false;
        adapter.setSharedProperty('abexp.assignmentcontext', 'stale;');
        adapter.postEvent('tas-call', new Map([['callType', 'assignments'], ['outcome', 'Success']]));
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
        sinon.assert.notCalled(send);
        sinon.assert.notCalled(onCall);
    });
});
