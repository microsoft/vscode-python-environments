// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import { ExperimentationConfiguration } from '../../../common/experimentation/configuration';
import { ExperimentationStorage, TAS_CACHE_KEY } from '../../../common/experimentation/storage';
import * as logging from '../../../common/logging';
import { MockMemento } from '../../mocks/mementos';

const configuration: ExperimentationConfiguration = {
    assignmentsEndpoint: 'https://assignments.example.invalid/api/v1/assignments',
    targetPopulation: 'public',
    identityParameter: 'approved_identity',
    assignmentParameters: { approved_identity: 'machineId' },
};
const assignments = {
    features: [],
    assignmentContext: 'control;',
    configs: [{ Id: 'vscode', Parameters: { example: false } }],
};

suite('Experimentation storage', () => {
    teardown(() => sinon.restore());

    test('persists through globalState and reuses the same identity and configuration after restart', async () => {
        const globalState = new MockMemento();
        const first = new ExperimentationStorage(globalState, configuration, 'machine-a', '1.0.0', () => true);
        await globalState.update('unrelated', 1);
        await first.update(TAS_CACHE_KEY, assignments);
        const restarted = new ExperimentationStorage(globalState, configuration, 'machine-a', '1.0.0', () => true);
        assert.deepStrictEqual(restarted.get(TAS_CACHE_KEY), assignments);
        assert.strictEqual(restarted.hasCachedAssignments(), true);
        assert.deepStrictEqual(restarted.keys(), [TAS_CACHE_KEY]);
        assert.strictEqual(globalState.get('unrelated'), 1);
        assert.ok(globalState.keys().every((key) => !key.includes('machine-a')));
    });

    test('does not reuse another identity, audience, endpoint or extension version', async () => {
        const globalState = new MockMemento();
        const original = new ExperimentationStorage(globalState, configuration, 'a', '1', () => true);
        await original.update(TAS_CACHE_KEY, assignments);
        const others = [
            new ExperimentationStorage(globalState, configuration, 'b', '1', () => true),
            new ExperimentationStorage(
                globalState, { ...configuration, targetPopulation: 'insider' }, 'a', '1', () => true,
            ),
            new ExperimentationStorage(globalState, {
                ...configuration, assignmentsEndpoint: 'https://other.example.invalid/api/v1/assignments',
            }, 'a', '1', () => true),
            new ExperimentationStorage(globalState, configuration, 'a', '2', () => true),
        ];
        assert.ok(others.every((storage) => !storage.hasCachedAssignments()));
    });

    test('an empty but valid assignment response is a cached snapshot', async () => {
        const storage = new ExperimentationStorage(new MockMemento(), configuration, 'a', '1', () => true);
        await storage.update(TAS_CACHE_KEY, { features: [], assignmentContext: '', configs: [] });
        assert.strictEqual(storage.hasCachedAssignments(), true);
    });

    test('malformed cache is ignored and reported without logging its contents', async () => {
        const warn = sinon.stub(logging, 'traceWarn');
        const storage = new ExperimentationStorage(new MockMemento(), configuration, 'a', '1', () => true);
        await storage.update(TAS_CACHE_KEY, 'malformed private payload');
        assert.strictEqual(storage.hasCachedAssignments(), false);
        assert.strictEqual(storage.get(TAS_CACHE_KEY), undefined);
        sinon.assert.calledOnce(warn);
        assert.ok(!JSON.stringify(warn.args).includes('private payload'));
    });

    test('does not write after its SDK generation is stopped', async () => {
        const globalState = new MockMemento();
        let active = true;
        const storage = new ExperimentationStorage(globalState, configuration, 'a', '1', () => active);
        await storage.update(TAS_CACHE_KEY, assignments);
        active = false;
        await storage.update(TAS_CACHE_KEY, { features: [], assignmentContext: 'late;', configs: [] });
        assert.deepStrictEqual(storage.get(TAS_CACHE_KEY), assignments);
    });

    test('observes persistence failures even when the SDK does not await writes', async () => {
        const globalState = new MockMemento();
        sinon.stub(globalState, 'update').rejects(new Error('storage unavailable'));
        const warn = sinon.stub(logging, 'traceWarn');
        const storage = new ExperimentationStorage(globalState, configuration, 'a', '1', () => true);
        await assert.doesNotReject(storage.update(TAS_CACHE_KEY, assignments));
        sinon.assert.calledOnce(warn);
        assert.strictEqual(storage.hasCachedAssignments(), false);
    });
});
