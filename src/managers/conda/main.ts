import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { CondaEnvManager } from './condaEnvManager';
import { CondaPackageManager } from './condaPackageManager';

export async function registerCondaFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    traceInfo('Registering conda manager (environments will be discovered lazily)');
    const envManager = new CondaEnvManager(nativeFinder, api, log, projectManager);
    const packageManager = new CondaPackageManager(api, log);

    disposables.push(
        envManager,
        packageManager,
        api.registerEnvironmentManager(envManager),
        api.registerPackageManager(packageManager),
    );
}
