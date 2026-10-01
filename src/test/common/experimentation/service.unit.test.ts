// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'vscode';
import { ENVS_EXTENSION_ID } from '../../../common/constants';
import * as envApis from '../../../common/env.apis';
import type { ExperimentationConfiguration } from '../../../common/experimentation/configuration';
import {
    EXPERIMENTATION_INITIALIZATION_TIMEOUT_MS,
    ExperimentationClient,
    ExperimentationClientFactory,
    ExperimentationClientOptions,
    ExperimentationContext,
    ExperimentationService,
} from '../../../common/experimentation/service';
import { ExperimentationStorage, TAS_CACHE_KEY } from '../../../common/experimentation/storage';
import { TasCall } from '../../../common/experimentation/telemetry';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import { getSharedTelemetryProperties } from '../../../common/telemetry/reporter';
import * as sender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import { MockMemento } from '../../mocks/mementos';

const CONFIGURATION: ExperimentationConfiguration = {
    assignmentsEndpoint: 'https://assignments.example.invalid/api/v1/assignments',
    targetPopulation: 'public',
    identityParameter: 'approved_identity',
    assignmentParameters: {
        approved_identity: 'machineId',
        approved_version: 'extensionVersion',
        approved_language: 'language',
    },
};
const VERSION = '1.39.0';
const IDENTITY = 'test-machine';

class FakeSdk implements ExperimentationClient {
    readonly initialized = createDeferred<void>();
    readonly fetched = createDeferred<void>();
    readonly initializePromise = this.initialized.promise;
    readonly initialFetch = this.fetched.promise;
    readonly dispose = sinon.spy();
    readonly queried = sinon.spy();
    readonly values = new Map<string, unknown>();

    constructor(readonly options: ExperimentationClientOptions, initialize = true) {
        const cached = options.memento.get<{
            assignmentContext: string;
            configs: { Id: string; Parameters: Record<string, unknown> }[];
        }>(TAS_CACHE_KEY);
        if (cached) {
            for (const [name, value] of Object.entries(cached.configs[0]?.Parameters ?? {})) {
                this.values.set(name, value);
            }
            options.telemetry.setSharedProperty('abexp.assignmentcontext', cached.assignmentContext);
        }
        if (initialize) {
            this.initialized.resolve();
        }
    }

    getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined {
        this.queried(configId, name);
        return this.values.get(name) as T | undefined;
    }

    report(callType: TasCall['callType'], outcome: TasCall['outcome']): void {
        this.options.telemetry.postEvent('tas-call', new Map([['callType', callType], ['outcome', outcome]]));
    }

    async publish(values: Record<string, unknown>, context = 'treatment;'): Promise<void> {
        Object.entries(values).forEach(([name, value]) => this.values.set(name, value));
        this.report('assignments', 'Success');
        this.options.telemetry.setSharedProperty('abexp.assignmentcontext', context);
        await this.options.memento.update(TAS_CACHE_KEY, {
            features: Object.keys(values), assignmentContext: context,
            configs: [{ Id: 'vscode', Parameters: values }],
        });
        this.fetched.resolve();
    }
}

suite('Experimentation service', () => {
    let clock: sinon.SinonFakeTimers;
    let consent: boolean;
    let changed: EventEmitter<boolean>;
    let state: MockMemento;
    let context: ExperimentationContext;
    let clients: FakeSdk[];
    let services: ExperimentationService[];
    let factory: sinon.SinonSpy<[ExperimentationClientOptions], FakeSdk>;
    let events: sinon.SinonStub;
    let warn: sinon.SinonStub;
    let logError: sinon.SinonStub;

    setup(() => {
        clock = sinon.useFakeTimers();
        consent = true;
        changed = new EventEmitter<boolean>();
        state = new MockMemento();
        context = {
            globalState: state,
            extension: { packageJSON: { version: VERSION, experimentation: CONFIGURATION } },
        };
        clients = [];
        services = [];
        factory = sinon.spy((options: ExperimentationClientOptions) => {
            const client = new FakeSdk(options);
            clients.push(client);
            return client;
        });
        sinon.stub(envApis, 'isTelemetryEnabled').callsFake(() => consent);
        sinon.stub(envApis, 'onDidChangeTelemetryEnabled').callsFake((listener) => changed.event(listener));
        sinon.stub(envApis, 'getMachineId').returns(IDENTITY);
        sinon.stub(envApis, 'getLanguage').returns('en');
        events = sinon.stub(sender, 'sendTelemetryEvent');
        warn = sinon.stub(logging, 'traceWarn');
        logError = sinon.stub(logging, 'traceError');
    });

    teardown(() => {
        services.forEach((service) => service.dispose());
        changed.dispose();
        clock.restore();
        sinon.restore();
    });

    function start(createClient: ExperimentationClientFactory = factory): ExperimentationService {
        const service = new ExperimentationService(context, createClient);
        services.push(service);
        return service;
    }

    async function cache(values: Record<string, unknown> = { example: true }): Promise<void> {
        await new ExperimentationStorage(state, CONFIGURATION, IDENTITY, VERSION, () => true).update(TAS_CACHE_KEY, {
            features: Object.keys(values), assignmentContext: 'cached;',
            configs: [{ Id: 'vscode', Parameters: values }],
        });
    }

    function changeConsent(value: boolean): void {
        consent = value;
        changed.fire(value);
    }

    test('an unconfigured build never creates an SDK, reads an identity, or fetches', async () => {
        context = { ...context, extension: { packageJSON: { version: VERSION } } };
        const service = start();
        await service.initializePromise;
        await service.initialFetch;
        assert.strictEqual(service.diagnostics.state, 'notConfigured');
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        sinon.assert.notCalled(factory);
        sinon.assert.notCalled(envApis.getMachineId as sinon.SinonStub);
    });

    test('invalid configuration is reported and does not fall back to a legacy-only client', async () => {
        context = {
            ...context,
            extension: { packageJSON: { experimentation: { ...CONFIGURATION, identityParameter: undefined } } },
        };
        const service = start();
        await service.initializePromise;
        assert.strictEqual(service.diagnostics.state, 'failed');
        sinon.assert.notCalled(factory);
        sinon.assert.calledOnce(logError);
    });

    test('uses this extension identity, approved new parameter names, and a scoped global memento', async () => {
        const service = start();
        await service.initializePromise;
        const options = clients[0].options;
        assert.strictEqual(options.extensionName, ENVS_EXTENSION_ID);
        assert.strictEqual(options.extensionVersion, VERSION);
        assert.strictEqual(options.targetPopulation, 'public');
        assert.strictEqual(options.assignmentsEndpoint, CONFIGURATION.assignmentsEndpoint);
        assert.deepStrictEqual(options.assignmentsFilterProviders?.[0].getFilters(), new Map([
            ['approved_identity', IDENTITY], ['approved_version', VERSION], ['approved_language', 'en'],
        ]));
        assert.ok(options.fetch, 'both endpoints use the lifetime-bound transport');
        assert.strictEqual(options.filterProviders, undefined, 'new parameters must not become legacy headers');
    });

    test('cold initialization does not claim a successful fetch or consume an empty snapshot', async () => {
        const service = start();
        await service.initializePromise;
        assert.strictEqual(service.diagnostics.state, 'ready');
        assert.strictEqual(service.diagnostics.cacheState, 'absent');
        assert.strictEqual(service.diagnostics.initialFetch, 'pending');
        assert.strictEqual(service.diagnostics.assignmentsFetch, 'notObserved');
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        sinon.assert.notCalled(clients[0].queried);
        const initialized = events.getCalls().find(
            (call) => call.args[0] === EventNames.EXPERIMENTATION_INITIALIZATION,
        );
        assert.strictEqual(initialized?.args[2].result, 'cacheReady');
    });

    test('warm cache can be queried before networking completes', async () => {
        await cache();
        const service = start();
        await service.initializePromise;
        assert.strictEqual(service.diagnostics.cacheState, 'present');
        assert.strictEqual(service.diagnostics.initialFetch, 'pending');
        assert.strictEqual(service.diagnostics.assignmentsFetch, 'notObserved');
        assert.strictEqual(service.getTreatmentVariable('example', false), true);
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'cached;' });
    });

    test('serves newly fetched Boolean, number and string assignments with type-appropriate defaults', async () => {
        const service = start();
        await service.initializePromise;
        await clients[0].publish({ enabled: true, limit: 3, mode: 'treatment', control: false });
        await service.initialFetch;
        assert.strictEqual(service.diagnostics.assignmentsFetch, 'Success');
        assert.strictEqual(service.getTreatmentVariable('enabled', false), true);
        assert.strictEqual(service.getTreatmentVariable('limit', 1), 3);
        assert.strictEqual(service.getTreatmentVariable('mode', 'control'), 'treatment');
        assert.strictEqual(service.getTreatmentVariable('control', true), false);
        assert.strictEqual(service.getTreatmentVariable('missing', 7), 7);
        sinon.assert.calledWithExactly(clients[0].queried, 'vscode', 'enabled');
    });

    test('does not expose a successful provider response before the SDK commits its merged snapshot', async () => {
        const service = start();
        await service.initializePromise;
        clients[0].values.set('example', true);
        clients[0].report('assignments', 'Success');
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        sinon.assert.notCalled(clients[0].queried);
        await clients[0].publish({ example: true });
        assert.strictEqual(service.getTreatmentVariable('example', false), true);
    });

    test('retains a successful snapshot and attribution when later polling fails', async () => {
        const service = start();
        await service.initializePromise;
        await clients[0].publish({ example: true });
        await service.initialFetch;
        clients[0].report('assignments', 'NoResponse');
        clients[0].report('legacy', 'NoResponse');
        assert.strictEqual(service.getTreatmentVariable('example', false), true);
        assert.strictEqual(service.diagnostics.assignmentsFetch, 'NoResponse');
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'treatment;' });
    });

    test('missing or wrong-typed assignments never enable a Boolean feature', async () => {
        const service = start();
        await service.initializePromise;
        await clients[0].publish({ stringBoolean: 'true', numberBoolean: 1, object: {}, invalidNumber: NaN });
        await service.initialFetch;
        assert.strictEqual(service.getTreatmentVariable('missing', false), false);
        assert.strictEqual(service.getTreatmentVariable('stringBoolean', false), false);
        assert.strictEqual(service.getTreatmentVariable('numberBoolean', false), false);
        assert.strictEqual(service.getTreatmentVariable('object', 'default'), 'default');
        assert.strictEqual(service.getTreatmentVariable('invalidNumber', 1), 1);
        assert.strictEqual(warn.callCount, 4);
        service.getTreatmentVariable('stringBoolean', false);
        assert.strictEqual(warn.callCount, 4, 'the same bad treatment should not flood logs');
    });

    test('rejects invalid variable names without asking the SDK', async () => {
        await cache();
        const service = start();
        await service.initializePromise;
        assert.strictEqual(service.getTreatmentVariable('/vscode/example', false), false);
        assert.strictEqual(service.getTreatmentVariable('', false), false);
        sinon.assert.notCalled(clients[0].queried);
        assert.strictEqual(warn.callCount, 2);
    });

    test('a completed failed fetch is not reported as successful assignment', async () => {
        const service = start();
        await service.initializePromise;
        clients[0].report('assignments', 'NoResponse');
        clients[0].report('legacy', 'GenericError');
        clients[0].fetched.resolve();
        await service.initialFetch;
        assert.strictEqual(service.diagnostics.initialFetch, 'completed');
        assert.strictEqual(service.diagnostics.assignmentsFetch, 'NoResponse');
        assert.strictEqual(service.diagnostics.hasUsableSnapshot, false);
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        sinon.assert.notCalled(clients[0].queried);
        await clients[0].publish({ example: true });
        assert.strictEqual(
            service.getTreatmentVariable('example', false), true, 'a later successful poll can recover',
        );
    });

    test('keeps warm-cache values when the first network attempt rejects', async () => {
        await cache();
        const service = start();
        await service.initializePromise;
        clients[0].fetched.reject(new Error('offline'));
        await service.initialFetch;
        assert.strictEqual(service.diagnostics.initialFetch, 'failed');
        assert.strictEqual(service.getTreatmentVariable('example', false), true);
        assert.ok(warn.called);
    });

    test('a throwing SDK factory is nonfatal and reported', async () => {
        const service = start(() => { throw new Error('module unavailable'); });
        await service.initializePromise;
        assert.strictEqual(service.diagnostics.state, 'failed');
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        sinon.assert.calledOnce(logError);
    });

    test('a rejected cache initialization disposes the client and clears attribution', async () => {
        const service = start((options) => {
            const client = new FakeSdk(options, false);
            clients.push(client);
            options.telemetry.setSharedProperty('abexp.assignmentcontext', 'partial;');
            client.initialized.reject(new Error('bad cache'));
            return client;
        });
        await service.initializePromise;
        assert.strictEqual(service.diagnostics.state, 'failed');
        sinon.assert.calledOnce(clients[0].dispose);
        assert.strictEqual(service.diagnostics.initialFetch, 'failed');
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
    });

    test('cache initialization has a deadline and ignores late completion', async () => {
        const service = start((options) => {
            const client = new FakeSdk(options, false);
            clients.push(client);
            return client;
        });
        const pending = service.initializePromise;
        await clock.tickAsync(EXPERIMENTATION_INITIALIZATION_TIMEOUT_MS);
        await pending;
        assert.strictEqual(service.diagnostics.state, 'failed');
        assert.strictEqual(service.diagnostics.initialFetch, 'timeout');
        clients[0].initialized.resolve();
        await clock.tickAsync(0);
        assert.strictEqual(service.diagnostics.state, 'failed');
        sinon.assert.calledOnce(clients[0].dispose);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('disposes a client whose module finishes loading after initialization timed out', async () => {
        const loaded = createDeferred<ExperimentationClient>();
        let options: ExperimentationClientOptions | undefined;
        const service = start((value) => { options = value; return loaded.promise; });
        await clock.tickAsync(EXPERIMENTATION_INITIALIZATION_TIMEOUT_MS);
        await service.initializePromise;
        assert.ok(options);
        const lateClient = new FakeSdk(options);
        loaded.resolve(lateClient);
        await clock.tickAsync(0);
        sinon.assert.calledOnce(lateClient.dispose);
        assert.strictEqual(service.diagnostics.state, 'failed');
    });

    test('bounds a first-fetch promise that never settles', async () => {
        const service = start();
        await service.initializePromise;
        const pending = service.initialFetch;
        await clock.tickAsync(15_000);
        await pending;
        assert.strictEqual(service.diagnostics.initialFetch, 'timeout');
        assert.strictEqual(service.diagnostics.state, 'failed');
        sinon.assert.calledOnce(clients[0].dispose);
    });

    test('telemetry disabled at startup makes no SDK or identity requests', async () => {
        consent = false;
        const service = start();
        await service.initializePromise;
        assert.strictEqual(service.diagnostics.state, 'disabled');
        sinon.assert.notCalled(factory);
        sinon.assert.notCalled(envApis.getMachineId as sinon.SinonStub);
    });

    test('consent revocation stops polling, clears attribution, blocks requests, and ignores old writes', async () => {
        const service = start();
        await service.initializePromise;
        await clients[0].publish({ example: true });
        const old = clients[0];
        const cached = old.options.memento.get(TAS_CACHE_KEY);
        changeConsent(false);
        assert.strictEqual(service.diagnostics.state, 'disabled');
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        sinon.assert.calledOnce(old.dispose);
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
        await assert.rejects(old.options.fetch!('https://unused.example.invalid', { method: 'GET', headers: {} }));
        await old.publish({ example: false }, 'late;');
        assert.deepStrictEqual(old.options.memento.get(TAS_CACHE_KEY), cached);
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
    });

    test('consent restoration starts one replacement and stale callbacks cannot replace its state', async () => {
        const service = start();
        await service.initializePromise;
        const old = clients[0];
        changeConsent(false);
        changeConsent(true);
        await service.initializePromise;
        assert.strictEqual(clients.length, 2);
        await clients[1].publish({ example: true }, 'current;');
        old.report('assignments', 'NoResponse');
        old.options.telemetry.setSharedProperty('abexp.assignmentcontext', 'stale;');
        old.fetched.resolve();
        await clock.tickAsync(0);
        assert.deepStrictEqual(getSharedTelemetryProperties(), { 'abexp.assignmentcontext': 'current;' });
        assert.strictEqual(service.diagnostics.assignmentsFetch, 'Success');
        changed.fire(true);
        assert.strictEqual(clients.length, 2, 'a repeated consent value must not make another client');
    });

    test('dispose is idempotent, releases waiting callers, and prevents future consent restarts', async () => {
        const service = start();
        await service.initializePromise;
        const fetch = service.initialFetch;
        service.dispose();
        service.dispose();
        await fetch;
        changeConsent(false);
        changeConsent(true);
        assert.strictEqual(service.diagnostics.state, 'disposed');
        assert.strictEqual(factory.callCount, 1);
        sinon.assert.calledOnce(clients[0].dispose);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('automated extension hosts cannot construct a live SDK even with publisher configuration', () => {
        const service = new ExperimentationService(context, factory, true);
        services.push(service);
        assert.strictEqual(service.diagnostics.state, 'disabled');
        sinon.assert.notCalled(factory);
    });

    test('consent revocation during module loading cannot publish a late client', async () => {
        const loaded = createDeferred<ExperimentationClient>();
        let options: ExperimentationClientOptions | undefined;
        const service = start((value) => { options = value; return loaded.promise; });
        const initialized = service.initializePromise;
        changeConsent(false);
        await initialized;
        assert.ok(options);
        const lateClient = new FakeSdk(options);
        loaded.resolve(lateClient);
        await clock.tickAsync(0);
        sinon.assert.calledOnce(lateClient.dispose);
        assert.strictEqual(service.diagnostics.state, 'disabled');
        assert.deepStrictEqual(getSharedTelemetryProperties(), {});
    });

    test('a thrown treatment query is contained without losing initialization', async () => {
        await cache();
        const service = start();
        await service.initializePromise;
        sinon.stub(clients[0], 'getTreatmentVariable').throws(new Error('query failed'));
        assert.strictEqual(service.getTreatmentVariable('example', false), false);
        assert.strictEqual(service.diagnostics.state, 'ready');
        sinon.assert.calledOnce(warn);
    });
});
