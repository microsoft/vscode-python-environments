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
    let stage = 'getPythonApi';
    const api: PythonEnvironmentApi = await getPythonApi();

    let condaPath: string | undefined;
    try {
        // get Conda will return only ONE conda manager, that correlates to a single conda install
        stage = 'getConda';
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

    // Conda was found — errors below are real registration failures (let safeRegister handle telemetry)
    try {
        stage = 'constructCondaSourcingStatus';
        const sourcingStatus: CondaSourcingStatus = await constructCondaSourcingStatus(condaPath);
        traceInfo(sourcingStatus.toString());

        stage = 'createEnvManager';
        const envManager = new CondaEnvManager(nativeFinder, api, log);
        stage = 'createPkgManager';
        const packageManager = new CondaPackageManager(api, log);

        envManager.sourcingInformation = sourcingStatus;

        stage = 'registerManagers';
        disposables.push(
            envManager,
            packageManager,
            api.registerEnvironmentManager(envManager),
            api.registerPackageManager(packageManager),
        );
    } catch (ex) {
        await notifyMissingManagerIfDefault('ms-python.python:conda', projectManager, api);
        const err = ex instanceof Error ? ex : new Error(String(ex));
        (err as Error & { failureStage?: string }).failureStage = stage;
        throw err;
    }
}
