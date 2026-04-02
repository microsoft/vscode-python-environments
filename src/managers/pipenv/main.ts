import { Disposable } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PipenvManager } from './pipenvManager';

export async function registerPipenvFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    traceInfo('Registering pipenv manager (environments will be discovered lazily)');
    const mgr = new PipenvManager(nativeFinder, api);
    disposables.push(mgr, api.registerEnvironmentManager(mgr));
}
