import { Disposable } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { notifyMissingManagerIfDefault } from '../common/utils';
import { PyEnvManager } from './pyenvManager';
import { getPyenv } from './pyenvUtils';

export async function registerPyenvFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        const pyenv = await getPyenv(nativeFinder);

        if (pyenv) {
            const mgr = new PyEnvManager(nativeFinder, api);
            disposables.push(mgr, api.registerEnvironmentManager(mgr));
        } else {
            traceInfo('Pyenv not found, turning off pyenv features.');
            sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_SKIPPED, undefined, {
                managerName: 'pyenv',
                reason: 'tool_not_found',
            });
            await notifyMissingManagerIfDefault('ms-python.python:pyenv', projectManager, api);
        }
    } catch (ex) {
        traceInfo('Pyenv not found, turning off pyenv features.', ex);
        await notifyMissingManagerIfDefault('ms-python.python:pyenv', projectManager, api);
    }
}
