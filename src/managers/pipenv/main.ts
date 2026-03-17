import { Disposable } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PipenvManager } from './pipenvManager';
import { getPipenv, hasPipenvEnvironments } from './pipenvUtils';

import { notifyMissingManagerIfDefault } from '../common/utils';

export async function registerPipenvFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        const pipenv = await getPipenv(nativeFinder);

        // Register the manager if the CLI is found, or if there are existing pipenv environments.
        // This allows users with existing pipenv environments to still see and use them.
        const hasPipenvEnvs = !pipenv && (await hasPipenvEnvironments(nativeFinder));

        if (pipenv || hasPipenvEnvs) {
            const mgr = new PipenvManager(nativeFinder, api);
            disposables.push(mgr, api.registerEnvironmentManager(mgr));
            if (!pipenv) {
                traceInfo(
                    'Pipenv CLI not found, but pipenv environments were discovered. Registering manager for read-only environment management. To enable full pipenv features, set the "python.pipenvPath" setting to the path of your pipenv executable.',
                );
            }
        } else {
            traceInfo(
                'Pipenv not found, turning off pipenv features. If you have pipenv installed in a non-standard location, set the "python.pipenvPath" setting.',
            );
            sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_SKIPPED, undefined, {
                managerName: 'pipenv',
                reason: 'tool_not_found',
            });
            await notifyMissingManagerIfDefault('ms-python.python:pipenv', projectManager, api);
        }
    } catch (ex) {
        traceInfo(
            'Pipenv not found, turning off pipenv features. If you have pipenv installed in a non-standard location, set the "python.pipenvPath" setting.',
            ex,
        );
        sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_FAILED, undefined, {
            managerName: 'pipenv',
            errorType: classifyError(ex),
        });
        await notifyMissingManagerIfDefault('ms-python.python:pipenv', projectManager, api);
    }
}
