import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { CondaEnvManager } from './condaEnvManager';
import { CondaPackageManager } from './condaPackageManager';
import { CondaSourcingStatus, constructCondaSourcingStatus } from './condaSourcingUtils';
import { getConda } from './condaUtils';

export async function registerCondaFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        // get Conda will return only ONE conda manager, that correlates to a single conda install
        const condaPath: string = await getConda(nativeFinder);
        const sourcingStatus: CondaSourcingStatus = await constructCondaSourcingStatus(condaPath);
        traceInfo('Conda Sourcing Status:', sourcingStatus.toString());

        const envManager = new CondaEnvManager(nativeFinder, api, log);
        const packageManager = new CondaPackageManager(api, log);

        envManager.sourcingInformation = sourcingStatus;

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
