import { Disposable } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PyEnvManager } from './pyenvManager';

export async function registerPyenvFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    traceInfo('Registering pyenv manager (environments will be discovered lazily)');
    const mgr = new PyEnvManager(nativeFinder, api, projectManager);
    disposables.push(mgr, api.registerEnvironmentManager(mgr));
}
