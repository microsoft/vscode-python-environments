import { Disposable } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PipenvManager } from './pipenvManager';
import { PipenvPackageManager } from './pipenvPackageManager';
import { getPipenv } from './pipenvUtils';

export async function registerPipenvFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        const pipenv = await getPipenv(nativeFinder);

        if (pipenv) {
            const mgr = new PipenvManager(nativeFinder, api);
            const packageManager = new PipenvPackageManager(api);
            
            disposables.push(
                mgr,
                packageManager,
                api.registerEnvironmentManager(mgr),
                api.registerPackageManager(packageManager)
            );
        } else {
            traceInfo('Pipenv not found, turning off pipenv features.');
        }
    } catch (ex) {
        traceInfo('Pipenv not found, turning off pipenv features.', ex);
    }
}
