import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { CondaEnvManager } from './condaEnvManager';
import { CondaPackageManager } from './condaPackageManager';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { traceInfo } from '../../common/logging';
import { getConda, searchCondaSourcingInfo } from './condaUtils';

export async function registerCondaFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        await getConda(nativeFinder);
        
        // Search for conda sourcing scripts and shell profile information
        await searchCondaSourcingInfo();
        
        const envManager = new CondaEnvManager(nativeFinder, api, log);
        const packageManager = new CondaPackageManager(api, log);

        disposables.push(
            envManager,
            packageManager,
            api.registerEnvironmentManager(envManager),
            api.registerPackageManager(packageManager),
        );
    } catch (ex) {
        traceInfo('Conda not found, turning off conda features.', ex);
    }
}
