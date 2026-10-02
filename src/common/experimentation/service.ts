// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { Disposable, Memento } from 'vscode';
import type { ExperimentationConfig, IExperimentationService } from 'vscode-tas-client';
import { ENVS_EXTENSION_ID } from '../constants';
import { getLanguage, getMachineId, isTelemetryEnabled, onDidChangeTelemetryEnabled } from '../env.apis';
import { traceError, traceInfo, traceVerbose, traceWarn } from '../logging';
import { EventNames } from '../telemetry/constants';
import { setSharedTelemetryProperty } from '../telemetry/reporter';
import { sendTelemetryEvent } from '../telemetry/sender';
import { createDeferred, Deferred } from '../utils/deferred';
import {
    ExperimentationConfiguration,
    ExperimentationPopulation,
    getExperimentationExtensionVersion,
    readExperimentationConfiguration,
} from './configuration';
import { ExperimentationStorage } from './storage';
import { ASSIGNMENT_CONTEXT_PROPERTY, ExperimentationTelemetry, TasCall } from './telemetry';
import { createExperimentationFetch } from './transport';

export const EXPERIMENTATION_INITIALIZATION_TIMEOUT_MS = 5_000;
const INITIAL_FETCH_TIMEOUT_MS = 15_000;
type TreatmentValue = boolean | number | string;

export type ExperimentationClient = Pick<
    IExperimentationService,
    'initializePromise' | 'initialFetch' | 'getTreatmentVariable' | 'dispose'
>;
export type ExperimentationClientOptions = Omit<ExperimentationConfig, 'targetPopulation'> & {
    targetPopulation: ExperimentationPopulation;
};
export type ExperimentationClientFactory = (
    options: ExperimentationClientOptions,
) => ExperimentationClient | Promise<ExperimentationClient>;

export interface ExperimentationContext {
    readonly extension: { readonly packageJSON: unknown };
    readonly globalState: Memento;
}

export interface ExperimentationDiagnostics {
    readonly state: 'notConfigured' | 'disabled' | 'initializing' | 'ready' | 'failed' | 'disposed';
    readonly cacheState: 'present' | 'absent' | 'unknown';
    readonly hasUsableSnapshot: boolean;
    readonly initialFetch: 'notStarted' | 'pending' | 'completed' | 'failed' | 'timeout';
    readonly legacyFetch: 'notObserved' | TasCall['outcome'];
    readonly assignmentsFetch: 'notObserved' | TasCall['outcome'];
}

interface SdkRun {
    active: boolean;
    readonly controller: AbortController;
    readonly initialized: Deferred<void>;
    readonly fetched: Deferred<void>;
    readonly startedAt: number;
    client?: ExperimentationClient;
    initializationTimer?: ReturnType<typeof setTimeout>;
    fetchTimer?: ReturnType<typeof setTimeout>;
}

async function createSdk(options: ExperimentationClientOptions): Promise<ExperimentationClient> {
    const sdk = await import('vscode-tas-client');
    const populations = {
        public: sdk.TargetPopulation.Public,
        insider: sdk.TargetPopulation.Insiders,
        internal: sdk.TargetPopulation.Internal,
        team: sdk.TargetPopulation.Team,
    };
    return sdk.getExperimentationServiceFromConfig({
        ...options,
        targetPopulation: populations[options.targetPopulation],
    });
}

/** Own a consent-scoped SDK and expose defaulted snapshot queries. */
export class ExperimentationService implements Disposable {
    private readonly configuration?: ExperimentationConfiguration;
    private readonly version: string = '';
    private readonly consentSubscription?: Disposable;
    private run?: SdkRun;
    private disposed = false;
    private consent = false;
    private readonly warnedQueries = new Set<string>();
    private snapshot: ExperimentationDiagnostics = {
        state: 'notConfigured',
        cacheState: 'unknown',
        hasUsableSnapshot: false,
        initialFetch: 'notStarted',
        legacyFetch: 'notObserved',
        assignmentsFetch: 'notObserved',
    };

    constructor(
        private readonly context: ExperimentationContext,
        private readonly createClient: ExperimentationClientFactory = createSdk,
        disabledForTests = false,
    ) {
        try {
            this.configuration = readExperimentationConfiguration(context.extension.packageJSON);
            if (!this.configuration) {
                traceInfo(
                    '[experimentation] Not configured; no TAS requests will be made. See docs/experimentation.md.',
                );
                this.reportInitialization('notConfigured', 0);
                return;
            }
            this.version = getExperimentationExtensionVersion(context.extension.packageJSON);
            if (disabledForTests) {
                this.snapshot = { ...this.snapshot, state: 'disabled' };
                traceVerbose('[experimentation] Live TAS disabled in automated extension tests.');
                return;
            }
            this.consent = isTelemetryEnabled();
            this.consentSubscription = onDidChangeTelemetryEnabled((enabled) => {
                if (enabled === this.consent) {
                    return;
                }
                this.consent = enabled;
                this.restart();
            });
            this.restart();
        } catch (error) {
            this.snapshot = { ...this.snapshot, state: 'failed' };
            traceError(
                '[experimentation] Invalid configuration or unavailable consent API; no TAS requests started:',
                error,
            );
            this.reportInitialization('error', 0);
        }
    }

    /** Settle after cache initialization or bounded failure, not network success. */
    public get initializePromise(): Promise<void> {
        return this.run?.initialized.promise ?? Promise.resolve();
    }

    /** Settle after the first fetch attempt; diagnostics report its outcome. */
    public get initialFetch(): Promise<void> {
        return this.run?.fetched.promise ?? Promise.resolve();
    }

    /** Copy cache readiness and endpoint outcomes. */
    public get diagnostics(): ExperimentationDiagnostics {
        return { ...this.snapshot };
    }

    /** Read a bare vscode treatment name, using the default if unavailable or mistyped. */
    public getTreatmentVariable(name: string, defaultValue: boolean): boolean;
    public getTreatmentVariable(name: string, defaultValue: number): number;
    public getTreatmentVariable(name: string, defaultValue: string): string;
    public getTreatmentVariable(name: string, defaultValue: TreatmentValue): TreatmentValue {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,255}$/.test(name)) {
            this.warnQuery(name, 'Invalid treatment name; use a constant bare variable name.');
            return defaultValue;
        }
        const run = this.run;
        if (!run?.client || !this.isActive(run) || this.snapshot.state !== 'ready') {
            return defaultValue;
        }
        if (!this.snapshot.hasUsableSnapshot) {
            // Do not consume the SDK's empty snapshot before a cold fetch commits.
            return defaultValue;
        }
        try {
            const value = run.client.getTreatmentVariable<TreatmentValue>('vscode', name);
            if (value === undefined) {
                return defaultValue;
            }
            if (typeof value !== typeof defaultValue || (typeof value === 'number' && !Number.isFinite(value))) {
                this.warnQuery(name, 'Treatment type does not match its default.');
                return defaultValue;
            }
            return value;
        } catch (error) {
            this.warnQuery(name, 'Treatment lookup failed; using its default.');
            traceVerbose('[experimentation] Treatment lookup error:', error);
            return defaultValue;
        }
    }

    /** Stop requests and polling, invalidate callbacks, and clear attribution. */
    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.consentSubscription?.dispose();
        this.stopRun();
        this.snapshot = { ...this.snapshot, state: 'disposed' };
    }

    private restart(): void {
        if (this.disposed || !this.configuration) {
            return;
        }
        this.stopRun();
        this.snapshot = {
            state: this.consent ? 'initializing' : 'disabled',
            cacheState: 'unknown',
            hasUsableSnapshot: false,
            initialFetch: 'notStarted',
            legacyFetch: 'notObserved',
            assignmentsFetch: 'notObserved',
        };
        if (!this.consent) {
            traceVerbose('[experimentation] Telemetry consent disabled; TAS stopped.');
            return;
        }
        const run: SdkRun = {
            active: true,
            controller: new AbortController(),
            initialized: createDeferred<void>(),
            fetched: createDeferred<void>(),
            startedAt: Date.now(),
        };
        this.run = run;
        run.initializationTimer = setTimeout(
            () => this.failInitialization(run, 'timeout'),
            EXPERIMENTATION_INITIALIZATION_TIMEOUT_MS,
        );
        void this.initialize(run).catch((error) => {
            if (this.isActive(run)) {
                traceError('[experimentation] SDK initialization failed:', error);
                this.failInitialization(run, 'error');
            }
        });
    }

    private async initialize(run: SdkRun): Promise<void> {
        const configuration = this.configuration!;
        const identity = getMachineId();
        if (typeof identity !== 'string' || !identity.trim()) {
            throw new Error('The configured experimentation identity is unavailable.');
        }
        const values = { machineId: identity, extensionVersion: this.version, language: getLanguage() };
        const parameters = new Map<string, string>();
        for (const [name, source] of Object.entries(configuration.assignmentParameters)) {
            const value = values[source];
            if (typeof value !== 'string' || !value.trim()) {
                throw new Error('A configured experimentation audience value is unavailable.');
            }
            parameters.set(name, value);
        }
        const storage = new ExperimentationStorage(
            this.context.globalState, configuration, identity, this.version, () => this.isActive(run),
        );
        const cached = storage.hasCachedAssignments();
        this.snapshot = { ...this.snapshot, cacheState: cached ? 'present' : 'absent', hasUsableSnapshot: cached };
        const telemetry = new ExperimentationTelemetry(
            () => this.isActive(run),
            (call) => {
                this.snapshot = {
                    ...this.snapshot,
                    ...(call.callType === 'assignments'
                        ? { assignmentsFetch: call.outcome }
                        : { legacyFetch: call.outcome }),
                };
            },
            () => {
                // A provider success is not yet a committed SDK snapshot.
                if (this.snapshot.assignmentsFetch === 'Success' || this.snapshot.legacyFetch === 'Success') {
                    this.snapshot = { ...this.snapshot, hasUsableSnapshot: true };
                }
            },
        );
        const fetch = createExperimentationFetch(run.controller.signal);
        this.snapshot = { ...this.snapshot, initialFetch: 'pending' };
        const client = await this.createClient({
            extensionName: ENVS_EXTENSION_ID,
            extensionVersion: this.version,
            targetPopulation: configuration.targetPopulation,
            memento: storage,
            telemetry,
            assignmentsEndpoint: configuration.assignmentsEndpoint,
            assignmentsFilterProviders: [{ getFilters: () => new Map(parameters) }],
            fetch: (url, init) => {
                if (!this.isActive(run)) {
                    return Promise.reject(new Error('Experimentation request cancelled.'));
                }
                return fetch(url, init);
            },
        });
        if (!this.isActive(run)) {
            client.dispose();
            return;
        }
        run.client = client;
        this.observeInitialFetch(run, client);
        await client.initializePromise;
        if (!this.isActive(run)) {
            return;
        }
        clearTimeout(run.initializationTimer);
        this.snapshot = { ...this.snapshot, state: 'ready' };
        traceVerbose(
            `[experimentation] Cache initialization complete (${this.snapshot.cacheState}); ` +
                'this does not prove a successful fetch.',
        );
        this.reportInitialization('cacheReady', Date.now() - run.startedAt);
        run.initialized.resolve();
    }

    private observeInitialFetch(run: SdkRun, client: ExperimentationClient): void {
        const complete = (result: 'completed' | 'failed' | 'timeout') => {
            if (!this.isActive(run) || run.fetched.completed) {
                return;
            }
            clearTimeout(run.fetchTimer);
            this.snapshot = { ...this.snapshot, initialFetch: result };
            if (result !== 'completed' || this.snapshot.assignmentsFetch !== 'Success') {
                traceWarn(
                    '[experimentation] Initial fetch did not confirm assignments API success; inspect endpoint outcomes.',
                );
            } else {
                traceVerbose('[experimentation] Initial assignments API fetch confirmed successful.');
            }
            run.fetched.resolve();
            if (result === 'timeout') {
                this.stopRun();
                this.snapshot = { ...this.snapshot, state: 'failed' };
            }
        };
        run.fetchTimer = setTimeout(() => complete('timeout'), INITIAL_FETCH_TIMEOUT_MS);
        void client.initialFetch.then(
            () => complete('completed'),
            (error) => {
                if (this.isActive(run)) {
                    traceWarn('[experimentation] Initial fetch rejected:', error);
                }
                complete('failed');
            },
        );
    }

    private isActive(run: SdkRun): boolean {
        return !this.disposed && run.active && this.run === run && this.consent && isTelemetryEnabled();
    }

    private failInitialization(run: SdkRun, result: 'error' | 'timeout'): void {
        if (!this.isActive(run)) {
            return;
        }
        traceWarn(`[experimentation] Initialization ${result}; treatment queries will use their defaults.`);
        this.stopRun();
        this.snapshot = {
            ...this.snapshot,
            state: 'failed',
            initialFetch:
                this.snapshot.initialFetch === 'pending'
                    ? result === 'timeout' ? 'timeout' : 'failed'
                    : this.snapshot.initialFetch,
        };
        this.reportInitialization(result, Date.now() - run.startedAt);
    }

    private stopRun(): void {
        const run = this.run;
        if (run) {
            run.active = false;
            clearTimeout(run.initializationTimer);
            clearTimeout(run.fetchTimer);
            run.controller.abort();
            try {
                run.client?.dispose();
            } catch (error) {
                traceWarn('[experimentation] Failed to dispose the SDK:', error);
            }
            run.initialized.resolve();
            run.fetched.resolve();
            this.run = undefined;
        }
        setSharedTelemetryProperty(ASSIGNMENT_CONTEXT_PROPERTY, undefined);
        this.snapshot = { ...this.snapshot, hasUsableSnapshot: false };
    }

    private warnQuery(name: string, message: string): void {
        if (!this.warnedQueries.has(name)) {
            this.warnedQueries.add(name);
            traceWarn(`[experimentation] ${message}`);
        }
    }

    private reportInitialization(
        result: 'notConfigured' | 'disabled' | 'cacheReady' | 'error' | 'timeout',
        duration: number,
    ): void {
        sendTelemetryEvent(EventNames.EXPERIMENTATION_INITIALIZATION, duration, {
            result,
            cacheState: this.snapshot.cacheState,
        });
    }
}

let activeService: ExperimentationService | undefined;

/** Register the activation's internal service without awaiting networking. */
export function initializeExperimentation(
    context: ExperimentationContext & { subscriptions: Disposable[] },
): ExperimentationService {
    if (activeService) {
        return activeService;
    }
    const testExecution = [
        'VSC_PYTHON_CI_TEST', 'VSC_PYTHON_INTEGRATION_TEST', 'VSC_PYTHON_SMOKE_TEST', 'VSC_PYTHON_E2E_TEST',
    ].some((name) => !!process.env[name]);
    const service = new ExperimentationService(context, createSdk, testExecution);
    activeService = service;
    context.subscriptions.push({
        dispose: () => {
            service.dispose();
            if (activeService === service) {
                activeService = undefined;
            }
        },
    });
    return service;
}

/** Get the activation's internal experimentation service. */
export function getExperimentationService(): ExperimentationService | undefined {
    return activeService;
}
