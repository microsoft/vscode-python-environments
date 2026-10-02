// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type {
    ReplacementOption,
    TelemetryEventMeasurements,
    TelemetryEventProperties,
    TelemetryReporter,
} from '@vscode/extension-telemetry';
import type { TelemetryLoggerOptions } from 'vscode';

export class vscMockTelemetryReporter {
    public telemetryLevel: TelemetryReporter['telemetryLevel'] = 'all';

    constructor(
        _connectionString?: string,
        _replacementOptions?: ReplacementOption[],
        public readonly initializationOptions?: TelemetryLoggerOptions,
    ) {}

    public sendTelemetryEvent(
        _eventName: string,
        _properties?: TelemetryEventProperties,
        _measurements?: TelemetryEventMeasurements,
    ): void {
        // Noop.
    }

    public sendTelemetryErrorEvent(
        _eventName: string,
        _properties?: TelemetryEventProperties,
        _measurements?: TelemetryEventMeasurements,
    ): void {}

    public sendDangerousTelemetryEvent(
        _eventName: string,
        _properties?: TelemetryEventProperties,
        _measurements?: TelemetryEventMeasurements,
    ): void {}

    public async dispose(): Promise<void> {}
}
