import { Disposable, env, Uri, version } from 'vscode';
import type { TelemetryLogger, TelemetryLoggerOptions, TelemetrySender } from 'vscode';

export function launchBrowser(uri: string | Uri): Thenable<boolean> {
    return env.openExternal(uri instanceof Uri ? uri : Uri.parse(uri));
}

export function clipboardWriteText(text: string): Thenable<void> {
    return env.clipboard.writeText(text);
}

/** Read VS Code's usage-telemetry consent. */
export function isTelemetryEnabled(): boolean {
    return env.isTelemetryEnabled === true;
}

/** Subscribe to usage-telemetry consent changes. */
export function onDidChangeTelemetryEnabled(listener: (enabled: boolean) => void): Disposable {
    return env.onDidChangeTelemetryEnabled(listener);
}

/** Read the machine identifier for an approved identity binding. */
export function getMachineId(): string {
    return env.machineId;
}

/** Read the display language for an approved audience binding. */
export function getLanguage(): string {
    return env.language;
}

/** Read the VS Code application version used by built-in experimentation targeting. */
export function getVSCodeVersion(): string {
    return version;
}

/** Read the VS Code application name used by built-in experimentation targeting. */
export function getAppName(): string {
    return env.appName;
}

/** Create a VS Code logger that applies telemetry consent and data cleaning. */
export function createTelemetryLogger(sender: TelemetrySender, options?: TelemetryLoggerOptions): TelemetryLogger {
    return env.createTelemetryLogger(sender, options);
}
