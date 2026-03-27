import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { getPythonApi } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { notifyMissingManagerIfDefault } from '../common/utils';
import { PoetryManager } from './poetryManager';
import { PoetryPackageManager } from './poetryPackageManager';
import { getPoetry, getPoetryVersion } from './poetryUtils';

export async function registerPoetryFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
    projectManager: PythonProjectManager,
): Promise<void> {
    let stage = 'getPythonApi';
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        stage = 'getPoetry';
        const poetryPath = await getPoetry(nativeFinder);
        if (poetryPath) {
            traceInfo(
                'The `shell` command is not available by default in Poetry versions 2.0.0 and above. Therefore all shell activation will be handled by calling `source <path-to-activate>`. If you face any problems with shell activation, please file an issue at https://github.com/microsoft/vscode-python-environments/issues to help us improve this implementation.',
            );
            stage = 'getPoetryVersion';
            const version = await getPoetryVersion(poetryPath);
            traceInfo(`Poetry found at ${poetryPath}, version: ${version}`);
            stage = 'createEnvManager';
            const envManager = new PoetryManager(nativeFinder, api);
            stage = 'createPkgManager';
            const pkgManager = new PoetryPackageManager(api, outputChannel, envManager);

            stage = 'registerManagers';
            disposables.push(
                envManager,
                pkgManager,
                api.registerEnvironmentManager(envManager),
                api.registerPackageManager(pkgManager),
            );
        } else {
            traceInfo('Poetry not found, turning off poetry features.');
            sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_SKIPPED, undefined, {
                managerName: 'poetry',
                reason: 'tool_not_found',
            });
            await notifyMissingManagerIfDefault('ms-python.python:poetry', projectManager, api);
        }
    } catch (ex) {
        const failureStage = (ex as Error & { failureStage?: string })?.failureStage ?? stage;
        traceInfo('Poetry not found, turning off poetry features.', ex);
        sendTelemetryEvent(EventNames.MANAGER_REGISTRATION_FAILED, undefined, {
            managerName: 'poetry',
            errorType: classifyError(ex),
            failureStage,
        });
        await notifyMissingManagerIfDefault('ms-python.python:poetry', projectManager, api);
    }
}
