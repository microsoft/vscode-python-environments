import { Disposable, l10n, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { showErrorMessage } from '../../common/window.apis';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { compareVersions } from '../common/utils';
import { PoetryManager } from './poetryManager';
import { PoetryPackageManager } from './poetryPackageManager';
import { getPoetry, getPoetryVersion, isPoetryShellPluginInstalled } from './poetryUtils';

export async function registerPoetryFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        const poetryPath = await getPoetry(nativeFinder);
        let shellSupported = true;
        if (poetryPath) {
            const version = await getPoetryVersion(poetryPath);
            if (!version) {
                showErrorMessage(l10n.t('Poetry version could not be determined.'));
                return;
            }
            if (version && compareVersions(version, '2.0.0') >= 0) {
                shellSupported = await isPoetryShellPluginInstalled(poetryPath);
                if (!shellSupported) {
                    showErrorMessage(
                        l10n.t(
                            'Poetry 2.0.0+ detected. The `shell` command is not available by default. Please install the shell plugin to enable shell activation. See  [here](https://python-poetry.org/docs/managing-environments/#activating-the-environment), shell [plugin](https://github.com/python-poetry/poetry-plugin-shell)',
                        ),
                    );
                    return;
                }
            }
        }

        const envManager = new PoetryManager(nativeFinder, api);
        const pkgManager = new PoetryPackageManager(api, outputChannel, envManager);

        disposables.push(
            envManager,
            pkgManager,
            api.registerEnvironmentManager(envManager),
            api.registerPackageManager(pkgManager),
        );
    } catch (ex) {
        traceInfo('Poetry not found, turning off poetry features.', ex);
    }
}
