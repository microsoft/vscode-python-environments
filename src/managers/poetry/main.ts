import { Disposable, l10n, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { showErrorMessage } from '../../common/window.apis';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { compareVersions } from '../common/utils';
import { PoetryManager } from './poetryManager';
import { PoetryPackageManager } from './poetryPackageManager';
import { getPoetry, getPoetryVersion } from './poetryUtils';

export async function registerPoetryFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        const poetryPath = await getPoetry(nativeFinder);
        if (poetryPath) {
            const version = await getPoetryVersion(poetryPath);
            if (!version) {
                showErrorMessage(l10n.t('Poetry version could not be determined.'));
                return;
            }
            traceInfo(
                'The `shell` command is not available by default in Poetry versions 2.0.0 and above. Therefore all shell activation will be handled by calling `source <path-to-poetry-executable>`. If you face any problems with shell activation, please file an issue at https://github.com/microsoft/vscode-python-environments/issues to help us improve this implementation.',
            );
            if (version && compareVersions(version, '2.0.0') >= 0) {
                traceInfo('Note: The current version of Poetry is 2.0.0 or higher.');
            } else {
                traceInfo('Note: The current version of Poetry is lower than 2.0.0.');
            }

            const envManager = new PoetryManager(nativeFinder, api);
            const pkgManager = new PoetryPackageManager(api, outputChannel, envManager);

            disposables.push(
                envManager,
                pkgManager,
                api.registerEnvironmentManager(envManager),
                api.registerPackageManager(pkgManager),
            );
        }
    } catch (ex) {
        traceInfo('Poetry not found, turning off poetry features.', ex);
    }
}
