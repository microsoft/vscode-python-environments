import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { notifyMissingManagerIfDefault } from '../common/utils';
import { CondaEnvManager } from './condaEnvManager';
import { CondaPackageManager } from './condaPackageManager';
import { CondaSourcingStatus, constructCondaSourcingStatus } from './condaSourcingUtils';
import { getConda } from './condaUtils';

export async function registerCondaFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    let condaPath: string | undefined;
    try {
        // get Conda will return only ONE conda manager, that correlates to a single conda install
        condaPath = await getConda(nativeFinder);
    } catch (ex) {
        traceInfo('Conda not found, turning off conda features.', ex);
        sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_SKIPPED, undefined, {
            managerName: 'conda',
            reason: 'tool_not_found',
        });
        await notifyMissingManagerIfDefault('ms-python.python:conda', projectManager, api);
        return;
    }

    // Conda was found — errors below are real registration failures (let safeRegister handle them)
    const sourcingStatus: CondaSourcingStatus = await constructCondaSourcingStatus(condaPath);
    traceInfo(sourcingStatus.toString());

    const envManager = new CondaEnvManager(nativeFinder, api, log);
    const packageManager = new CondaPackageManager(api, log);

    envManager.sourcingInformation = sourcingStatus;

    disposables.push(
        envManager,
        packageManager,
        api.registerEnvironmentManager(envManager),
        api.registerPackageManager(packageManager),
    );
}
