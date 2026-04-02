import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { createFileSystemWatcher, onDidDeleteFiles } from '../../common/workspace.apis';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PipPackageManager } from './pipManager';
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

    disposables.push(
        api.registerPackageManager(pkgManager),
        api.registerEnvironmentManager(envManager),
        api.registerEnvironmentManager(venvManager),
    );

    const venvDebouncedRefresh = createSimpleDebounce(500, () => {
        venvManager.watcherRefresh();
    });
    const activationWatcher = createFileSystemWatcher('{**/activate}', false, true, false);
    disposables.push(
        activationWatcher,
        activationWatcher.onDidCreate(() => {
            venvDebouncedRefresh.trigger();
        }),
        activationWatcher.onDidDelete(() => {
            venvDebouncedRefresh.trigger();
        }),
        onDidDeleteFiles(() => {
            venvDebouncedRefresh.trigger();
        }),
    );

    const packageDebouncedRefresh = createSimpleDebounce(500, async () => {
        const projects = await api.getPythonProjects();
        await Promise.all(
            projects.map(async (project) => {
                const env = await api.getEnvironment(project.uri);
                if (!env) {
                    return;
                }
                try {
                    await api.refreshPackages(env);
                } catch (ex) {
                    log.error(
                        `Failed to refresh packages for environment ${env.envId}: ${ex instanceof Error ? ex.message : String(ex)}`,
                    );
                }
            }),
        );
    });
    const packageWatcher = createFileSystemWatcher(
        '**/site-packages/*.dist-info/METADATA', 
        false, // don't ignore create events    (pip install)
        true,  // ignore change events          (content changes in METADATA don't affect package list)
        false  // don't ignore delete events    (pip uninstall)
    );
    disposables.push(
        packageDebouncedRefresh,
        packageWatcher,
        packageWatcher.onDidCreate(() => {
            packageDebouncedRefresh.trigger();
        }),
        packageWatcher.onDidDelete(() => {
            packageDebouncedRefresh.trigger();
        }),
    );
}
