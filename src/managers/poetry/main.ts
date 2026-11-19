import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { traceInfo } from '../../common/logging';
import { getPythonApi } from '../../extensionApi';
import type { PythonProjectManager } from '../../features/projectManager';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PoetryManager } from './poetryManager';
import { PoetryPackageManager } from './poetryPackageManager';

export async function registerPoetryFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    outputChannel: LogOutputChannel,
    projectManager: PythonProjectManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    traceInfo('Registering poetry manager (environments will be discovered lazily)');
    const envManager = new PoetryManager(nativeFinder, api, projectManager);
    const pkgManager = new PoetryPackageManager(api, outputChannel, envManager);

    disposables.push(
        envManager,
        pkgManager,
        api.registerEnvironmentManager(envManager),
        api.registerPackageManager(pkgManager),
    );
}
