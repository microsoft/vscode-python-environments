import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PoetryManager } from './poetryManager';
import { PoetryPackageManager } from './poetryPackageManager';

export async function registerPoetryFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    traceInfo('Registering poetry manager (environments will be discovered lazily)');
    const envManager = new PoetryManager(nativeFinder, api);
    const pkgManager = new PoetryPackageManager(api, outputChannel, envManager);

    disposables.push(
        envManager,
        pkgManager,
        api.registerEnvironmentManager(envManager),
        api.registerPackageManager(pkgManager),
    );
}
