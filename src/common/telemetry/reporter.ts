import type {
    TelemetryEventMeasurements,
    TelemetryEventProperties,
    TelemetryReporter,
} from '@vscode/extension-telemetry';
import { version as telemetryClientVersion } from '@vscode/extension-telemetry/package.json';
import { arch, platform, release } from 'os';
import type { Disposable, TelemetryLogger } from 'vscode';
import { createTelemetryLogger } from '../env.apis';
import { traceError } from '../logging';

/* __GDPR__COMMON__
    "abexp.assignmentcontext": {
        "classification": "SystemMetaData",
        "purpose": "FeatureInsight",
        "owner": "StellaHuang95",
        "comment": "SDK-provided experiment assignments associated with extension telemetry."
    }
*/
interface SharedTelemetryProperties {
    'abexp.assignmentcontext'?: string;
}

const sharedProperties: SharedTelemetryProperties = {};

class ReporterImpl {
    private static telemetryReporter: TelemetryReporter | undefined;
    private static automaticErrorLogger: TelemetryLogger | undefined;
    private static registration: symbol | undefined;

    static register(): symbol {
        const registration = Symbol();
        ReporterImpl.registration = registration;
        delete sharedProperties['abexp.assignmentcontext'];
        return registration;
    }

    static getTelemetryReporter() {
        if (!ReporterImpl.registration) {
            return undefined;
        }
        if (!ReporterImpl.telemetryReporter) {
            const { TelemetryReporter: Reporter }: typeof import('@vscode/extension-telemetry') =
                require('@vscode/extension-telemetry');
            const reporter = new Reporter(
                '0c6ae279ed8443289764825290e4f9e2-1a736e7c-1324-4338-be46-fc2a58ae4d14-7255',
                [
                    {
                        lookup: /(errorName|errorMessage|errorStack)/g,
                    },
                ],
                { ignoreUnhandledErrors: true },
            );
            try {
                ReporterImpl.automaticErrorLogger = ReporterImpl.createAutomaticErrorLogger(reporter);
                ReporterImpl.telemetryReporter = reporter;
            } catch (error) {
                void reporter.dispose().catch((disposeError) =>
                    traceError('Failed to dispose an unregistered telemetry reporter:', disposeError),
                );
                throw error;
            }
        }

        return ReporterImpl.telemetryReporter;
    }

    private static createAutomaticErrorLogger(reporter: TelemetryReporter): TelemetryLogger {
        const forward = (
            eventName: string,
            properties?: TelemetryEventProperties,
            measurements?: TelemetryEventMeasurements,
        ): void => {
            if (
                !ReporterImpl.registration ||
                ReporterImpl.telemetryReporter !== reporter ||
                (reporter.telemetryLevel !== 'all' && reporter.telemetryLevel !== 'error')
            ) {
                return;
            }
            try {
                // VS Code already checked consent and cleaned this data; avoid a second logger pass and name prefix.
                reporter.sendDangerousTelemetryEvent(
                    eventName, { ...properties, ...getSharedTelemetryProperties() }, measurements,
                );
            } catch (error) {
                traceError('Failed to send automatic error telemetry:', error);
            }
        };
        return createTelemetryLogger({
            sendEventData: (eventName, data) =>
                forward(eventName, data?.properties ?? data, data?.measurements),
            sendErrorData: (error, data) => forward('unhandlederror', {
                ...(data?.properties ?? data),
                name: error.name,
                message: error.message,
                stack: error.stack,
            }, data?.measurements),
        }, {
            additionalCommonProperties: {
                'common.os': platform(),
                'common.nodeArch': arch(),
                'common.platformversion': release().replace(/^(\d+)(\.\d+)?(\.\d+)?(.*)/, '$1$2$3'),
                'common.telemetryclientversion': telemetryClientVersion,
            },
        });
    }

    static async dispose(registration: symbol): Promise<void> {
        if (ReporterImpl.registration !== registration) {
            return;
        }
        ReporterImpl.registration = undefined;
        const reporter = ReporterImpl.telemetryReporter;
        ReporterImpl.telemetryReporter = undefined;
        const automaticErrorLogger = ReporterImpl.automaticErrorLogger;
        ReporterImpl.automaticErrorLogger = undefined;
        delete sharedProperties['abexp.assignmentcontext'];
        automaticErrorLogger?.dispose();
        await reporter?.dispose();
    }
}

/** Get the active registration's lazy reporter, or undefined outside its lifetime. */
export function getTelemetryReporter() {
    return ReporterImpl.getTelemetryReporter();
}

/** Set a classified shared property, or remove it with undefined. */
export function setSharedTelemetryProperty(name: keyof SharedTelemetryProperties, value: string | undefined): void {
    if (value === undefined) {
        delete sharedProperties[name];
    } else {
        sharedProperties[name] = value;
    }
}

/** Copy shared properties for one event. */
export function getSharedTelemetryProperties(): Readonly<SharedTelemetryProperties> {
    return { ...sharedProperties };
}

/** Register lazy telemetry ownership; stale disposers cannot end a newer registration. */
export function registerTelemetryReporter(): Disposable {
    const registration = ReporterImpl.register();
    return { dispose: () => ReporterImpl.dispose(registration) };
}
