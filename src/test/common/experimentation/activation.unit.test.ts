// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import type { Disposable } from 'vscode';
import {
    ExperimentationContext,
    getExperimentationService,
    initializeExperimentation,
} from '../../../common/experimentation/service';
import * as sender from '../../../common/telemetry/sender';
import { MockMemento } from '../../mocks/mementos';

suite('Experimentation activation registration', () => {
    let context: ExperimentationContext & { subscriptions: Disposable[] };

    setup(() => {
        sinon.stub(sender, 'sendTelemetryEvent');
        context = {
            globalState: new MockMemento(),
            extension: { packageJSON: { version: '1.39.0' } },
            subscriptions: [],
        };
    });

    teardown(() => {
        context.subscriptions.forEach((disposable) => disposable.dispose());
        sinon.restore();
    });

    test('registers exactly one accessible service without awaiting a network request', () => {
        const service = initializeExperimentation(context);
        assert.strictEqual(getExperimentationService(), service);
        assert.strictEqual(initializeExperimentation(context), service);
        assert.strictEqual(context.subscriptions.length, 1);
        assert.strictEqual(service.diagnostics.state, 'notConfigured');
    });

    test('deactivation releases the service and allows a fresh activation', () => {
        const first = initializeExperimentation(context);
        context.subscriptions[0].dispose();
        assert.strictEqual(first.diagnostics.state, 'disposed');
        assert.strictEqual(getExperimentationService(), undefined);
        const second = initializeExperimentation(context);
        assert.notStrictEqual(second, first);
        context.subscriptions[0].dispose();
        assert.strictEqual(getExperimentationService(), second, 'late old cleanup must not unset the new service');
    });
});
