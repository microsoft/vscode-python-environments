// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { IExperimentationTelemetry } from 'vscode-tas-client';
import { ENVS_EXTENSION_ID } from '../constants';
import { traceVerbose, traceWarn } from '../logging';
import { EventNames, IEventNamePropertyMapping } from '../telemetry/constants';
import { setSharedTelemetryProperty } from '../telemetry/reporter';
import { sendTelemetryEvent } from '../telemetry/sender';

export const ASSIGNMENT_CONTEXT_PROPERTY = 'abexp.assignmentcontext';
export type TasCall = IEventNamePropertyMapping[EventNames.EXPERIMENTATION_TAS_CALL];

function isOutcome(value: string | undefined): value is TasCall['outcome'] {
    return value === 'Success' || value === 'ServerError' || value === 'NoResponse' || value === 'GenericError';
}

/** Forward classified SDK telemetry only while its instance is active. */
export class ExperimentationTelemetry implements IExperimentationTelemetry {
    private readonly ignoredEvents = new Set<string>();

    constructor(
        private readonly isActive: () => boolean,
        private readonly onCall: (call: TasCall) => void,
        private readonly onContext: () => void = () => undefined,
    ) {}

    /** Share the active SDK's assignment context. */
    public setSharedProperty(name: string, value: string): void {
        if (!this.isActive()) {
            return;
        }
        if (name !== ASSIGNMENT_CONTEXT_PROPERTY) {
            this.warnOnce(`property:${name}`);
            return;
        }
        setSharedTelemetryProperty(ASSIGNMENT_CONTEXT_PROPERTY, value || undefined);
        this.onContext();
    }

    /** Forward allowlisted SDK events and properties. */
    public postEvent(eventName: string, properties: Map<string, string>): void {
        if (!this.isActive()) {
            return;
        }
        switch (eventName) {
            case EventNames.EXPERIMENTATION_QUERY: {
                const feature = properties.get('ABExp.queriedFeature');
                if (!feature || !/^vscode\.[A-Za-z0-9_.-]+$/.test(feature)) {
                    this.warnOnce(eventName);
                    return;
                }
                sendTelemetryEvent(EventNames.EXPERIMENTATION_QUERY, undefined, { 'ABExp.queriedFeature': feature });
                return;
            }
            case EventNames.EXPERIMENTATION_TAS_CALL: {
                const callType = properties.get('callType');
                const outcome = properties.get('outcome');
                if ((callType !== 'legacy' && callType !== 'assignments') || !isOutcome(outcome)) {
                    this.warnOnce(eventName);
                    return;
                }
                const call: TasCall = {
                    callType,
                    outcome,
                    extensionName: ENVS_EXTENSION_ID,
                    assignmentContext: properties.get('assignmentContext'),
                };
                this.onCall(call);
                traceVerbose(`[experimentation] ${callType} fetch: ${outcome}.`);
                sendTelemetryEvent(EventNames.EXPERIMENTATION_TAS_CALL, undefined, call);
                return;
            }
            case EventNames.EXPERIMENTATION_ASSIGNMENTS_VALIDATION: {
                const measures: Record<string, number> = {};
                for (const name of ['FeatureVariableCount', 'AssignedVariantCount']) {
                    const raw = properties.get(name);
                    const count = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
                    if (count !== undefined && Number.isSafeInteger(count)) {
                        measures[name] = count;
                    }
                }
                sendTelemetryEvent(EventNames.EXPERIMENTATION_ASSIGNMENTS_VALIDATION, measures, {
                    DataVersion: properties.get('DataVersion'),
                    AssignmentContext: properties.get('AssignmentContext'),
                });
                return;
            }
            case EventNames.EXPERIMENTATION_LEGACY_ERROR:
            case EventNames.EXPERIMENTATION_ASSIGNMENTS_ERROR: {
                const errorType = properties.get('ErrorType');
                if (!isOutcome(errorType) || errorType === 'Success') {
                    this.warnOnce(eventName);
                    return;
                }
                sendTelemetryEvent(eventName, undefined, { ErrorType: errorType });
                return;
            }
            default:
                this.warnOnce(eventName);
        }
    }

    private warnOnce(key: string): void {
        if (!this.ignoredEvents.has(key)) {
            this.ignoredEvents.add(key);
            traceWarn('[experimentation] Dropped an unclassified or malformed SDK telemetry payload.');
        }
    }
}
