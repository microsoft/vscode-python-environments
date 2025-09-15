import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { notifyMissingManagerIfDefault } from '../common/utils';
import { PipenvManager } from './pipenvManager';
import { PipenvPackageManager } from './pipenvPackageManager';
import { getPipenv, getPipenvVersion } from './pipenvUtils';

export async function registerPipenvFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        const pipenvPath = await getPipenv(nativeFinder);
        if (pipenvPath) {
            const version = await getPipenvVersion(pipenvPath);
            traceInfo(`Pipenv found at ${pipenvPath}, version: ${version || 'unknown'}`);
            const envManager = new PipenvManager(nativeFinder, api);
            const pkgManager = new PipenvPackageManager(api, outputChannel, envManager);

            disposables.push(
                envManager,
                pkgManager,
                api.registerEnvironmentManager(envManager),
                api.registerPackageManager(pkgManager),
            );
        } else {
            traceInfo('Pipenv not found, turning off pipenv features.');
            await notifyMissingManagerIfDefault('ms-python.python:pipenv', projectManager, api);
        }
    } catch (ex) {
        traceInfo('Pipenv not found, turning off pipenv features.', ex);
        await notifyMissingManagerIfDefault('ms-python.python:pipenv', projectManager, api);
    }
}