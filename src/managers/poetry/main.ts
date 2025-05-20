import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PoetryManager } from './poetryManager';
import { PoetryPackageManager } from './poetryPackageManager';
import { getPoetry } from './poetryUtils';

export async function registerPoetryFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        await getPoetry(nativeFinder);

        const envManager = new PoetryManager(nativeFinder, api);
        const pkgManager = new PoetryPackageManager(api, outputChannel, envManager);
        
        disposables.push(
            envManager, 
            pkgManager,
            api.registerEnvironmentManager(envManager),
            api.registerPackageManager(pkgManager)
        );
    } catch (ex) {
        traceInfo('Poetry not found, turning off poetry features.', ex);
    }
}
