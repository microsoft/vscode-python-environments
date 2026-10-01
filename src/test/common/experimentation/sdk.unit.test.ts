// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import { when } from 'ts-mockito';
import { Disposable } from 'vscode';
import type { FetchFn } from 'vscode-tas-client';
import * as envApis from '../../../common/env.apis';
import { ExperimentationService } from '../../../common/experimentation/service';
import * as transport from '../../../common/experimentation/transport';
import { getSharedTelemetryProperties } from '../../../common/telemetry/reporter';
import * as sender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import { MockMemento } from '../../mocks/mementos';
import { mockedVSCodeNamespaces } from '../../unittests';

suite('Experimentation SDK contract with fake transport', () => {
    let service: ExperimentationService | undefined;
    let calls: Parameters<FetchFn>[];
    let legacyFails: boolean;
    let state: MockMemento;
    let responsesReleased: Promise<void>;
    let assignedFlag: string;

    setup(() => {
        calls = [];
        legacyFails = false;
        state = new MockMemento();
        responsesReleased = Promise.resolve();
        assignedFlag = 'true';
        when(mockedVSCodeNamespaces.env!.isTelemetryEnabled).thenReturn(true);
        when(mockedVSCodeNamespaces.env!.machineId).thenReturn('sdk-test-machine');
        when(mockedVSCodeNamespaces.env!.language).thenReturn('en');
        sinon.stub(envApis, 'isTelemetryEnabled').returns(true);
        sinon.stub(envApis, 'onDidChangeTelemetryEnabled').returns(new Disposable(() => undefined));
        sinon.stub(envApis, 'getMachineId').returns('sdk-test-machine');
        sinon.stub(envApis, 'getLanguage').returns('en');
        sinon.stub(sender, 'sendTelemetryEvent');
        const fetch: FetchFn = async (url, init) => {
            calls.push([url, init]);
            await responsesReleased;
            if (legacyFails && init.method === 'GET') {
                throw new Error('simulated legacy failure');
            }
            return {
                status: 200,
                json: async () => init.method === 'GET'
                    ? {
                        Configs: [{ Id: 'vscode', Parameters: { genericFlag: false, legacyValue: 3 } }],
                        AssignmentContext: 'legacy;',
                    }
                    : {
                        featureVariables: { '/vscode/genericFlag': assignedFlag, '/vscode/mode': 'new' },
                        assignedVariants: [], dataVersion: 1, assignmentContext: 'assignments;',
                    },
            };
        };
        sinon.stub(transport, 'createExperimentationFetch').returns(fetch);
    });

    teardown(() => {
        service?.dispose();
        service = undefined;
        when(mockedVSCodeNamespaces.env!.isTelemetryEnabled).thenReturn(false);
        sinon.restore();
    });

    async function start(waitForFetch = true): Promise<ExperimentationService> {
        service = new ExperimentationService({
            globalState: state,
            extension: {
                packageJSON: {
                    version: '1.39.0',
                    experimentation: {
                        assignmentsEndpoint: 'https://assignments.example.invalid/api/v1/assignments',
                        targetPopulation: 'public',
                        identityParameter: 'approved_identity',
                        assignmentParameters: { approved_identity: 'machineId' },
                    },
                },
            },
        });
        await service.initializePromise;
        if (waitForFetch) {
            await service.initialFetch;
        }
        return service;
    }

    test('loads the installed SDK, uses both transports, and reads new assignments under bare names', async () => {
        const initialized = await start();
        assert.strictEqual(initialized.diagnostics.state, 'ready');
        assert.strictEqual(initialized.diagnostics.assignmentsFetch, 'Success');
        assert.strictEqual(initialized.diagnostics.legacyFetch, 'Success');
        assert.deepStrictEqual(calls.map((call) => call[1].method).sort(), ['GET', 'POST']);
        const post = calls.find((call) => call[1].method === 'POST');
        assert.ok(post?.[1].body);
        const body = JSON.parse(post[1].body);
        assert.strictEqual(body.userParams.approved_identity, 'sdk-test-machine');
        assert.strictEqual(body.userParams.vscode_core_extensionname, 'ms-python.vscode-python-envs');
        assert.strictEqual(initialized.getTreatmentVariable('genericFlag', false), true);
        assert.strictEqual(initialized.getTreatmentVariable('legacyValue', 0), 3);
        assert.strictEqual(initialized.getTreatmentVariable('mode', 'fallback'), 'new');
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'legacy;assignments;' });
    });

    test('a failed legacy endpoint cannot discard a successful assignments response', async () => {
        legacyFails = true;
        const initialized = await start();
        assert.strictEqual(initialized.diagnostics.assignmentsFetch, 'Success');
        assert.strictEqual(initialized.diagnostics.legacyFetch, 'GenericError');
        assert.strictEqual(initialized.getTreatmentVariable('genericFlag', false), true);
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'assignments;' });
    });

    test('reuses the persisted snapshot on restart and keeps a consumed decision while newer data is cached', async () => {
        const first = await start();
        assert.strictEqual(first.getTreatmentVariable('genericFlag', false), true);
        first.dispose();

        const release = createDeferred<void>();
        responsesReleased = release.promise;
        assignedFlag = 'false';
        const second = await start(false);
        assert.strictEqual(second.diagnostics.cacheState, 'present');
        assert.strictEqual(second.diagnostics.assignmentsFetch, 'notObserved');
        assert.strictEqual(second.getTreatmentVariable('genericFlag', false), true);
        release.resolve();
        await second.initialFetch;
        assert.strictEqual(second.diagnostics.assignmentsFetch, 'Success');
        assert.strictEqual(second.getTreatmentVariable('genericFlag', false), true, 'consumed decisions stay stable');
        second.dispose();

        const third = await start();
        assert.strictEqual(third.diagnostics.cacheState, 'present');
        assert.strictEqual(third.getTreatmentVariable('genericFlag', true), false, 'the next session sees the new cache');
    });
});
