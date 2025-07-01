import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { onDidEndTerminalShellExecution } from '../../common/window.apis';
import { createFileSystemWatcher, onDidDeleteFiles } from '../../common/workspace.apis';
import { PackageWatcherService } from '../../common/packageWatcher';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PipPackageManager } from './pipManager';
import { isPipInstallCommand } from './pipUtils';
import { SysPythonManager } from './sysPythonManager';
import { VenvManager } from './venvManager';

export async function registerSystemPythonFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    envManager: SysPythonManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();
    const venvManager = new VenvManager(nativeFinder, api, envManager, log);
    const pkgManager = new PipPackageManager(api, log, venvManager);

    // Create package watcher service for automatic package refresh
    const packageWatcher = new PackageWatcherService();

    disposables.push(
        api.registerPackageManager(pkgManager),
        api.registerEnvironmentManager(envManager),
        api.registerEnvironmentManager(venvManager),
        packageWatcher,
    );

    // Set up package watching for existing environments
    const setupPackageWatching = async () => {
        const environments = await api.getEnvironments('all');
        for (const env of environments) {
            const watcher = packageWatcher.watchEnvironment(env, pkgManager);
            disposables.push(watcher);
        }
    };

    // Set up package watching for new environments
    const environmentChangeDisposable = api.onDidChangeEnvironments((changes) => {
        for (const change of changes) {
            if (change.kind === 'add') {
                const watcher = packageWatcher.watchEnvironment(change.environment, pkgManager);
                disposables.push(watcher);
            }
        }
    });

    disposables.push(environmentChangeDisposable);

    // Initialize package watching for existing environments
    setupPackageWatching().catch((error) => {
        log.error('Failed to setup package watching', error);
    });

    const venvDebouncedRefresh = createSimpleDebounce(500, () => {
        venvManager.watcherRefresh();
    });
    const watcher = createFileSystemWatcher('{**/activate}', false, true, false);
    disposables.push(
        watcher,
        watcher.onDidCreate(() => {
            venvDebouncedRefresh.trigger();
        }),
        watcher.onDidDelete(() => {
            venvDebouncedRefresh.trigger();
        }),
        onDidDeleteFiles(() => {
            venvDebouncedRefresh.trigger();
        }),
    );

    disposables.push(
        onDidEndTerminalShellExecution(async (e) => {
            const cwd = e.terminal.shellIntegration?.cwd;
            if (isPipInstallCommand(e.execution.commandLine.value) && cwd) {
                const env = await venvManager.get(cwd);
                if (env) {
                    await pkgManager.refresh(env);
                }
            }
        }),
    );
}
