import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { PackageWatcherService } from '../../common/packageWatcher';
import { CondaEnvManager } from './condaEnvManager';
import { CondaPackageManager } from './condaPackageManager';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { traceInfo } from '../../common/logging';
import { getConda } from './condaUtils';

export async function registerCondaFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();

    try {
        await getConda(nativeFinder);
        const envManager = new CondaEnvManager(nativeFinder, api, log);
        const packageManager = new CondaPackageManager(api, log);

        // Create package watcher service for automatic package refresh
        const packageWatcher = new PackageWatcherService();

        disposables.push(
            envManager,
            packageManager,
            packageWatcher,
            api.registerEnvironmentManager(envManager),
            api.registerPackageManager(packageManager),
        );

        // Set up package watching for existing environments
        const setupPackageWatching = async () => {
            const environments = await api.getEnvironments('all');
            for (const env of environments) {
                const watcher = packageWatcher.watchEnvironment(env, packageManager);
                disposables.push(watcher);
            }
        };

        // Set up package watching for new environments
        const environmentChangeDisposable = api.onDidChangeEnvironments((changes) => {
            for (const change of changes) {
                if (change.kind === 'add') {
                    const watcher = packageWatcher.watchEnvironment(change.environment, packageManager);
                    disposables.push(watcher);
                }
            }
        });

        disposables.push(environmentChangeDisposable);

        // Initialize package watching for existing environments
        setupPackageWatching().catch((error) => {
            log.error('Failed to setup conda package watching', error);
        });
    } catch (ex) {
        traceInfo('Conda not found, turning off conda features.', ex);
    }
}
