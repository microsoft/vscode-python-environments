import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { createFileSystemWatcher, onDidDeleteFiles } from '../../common/workspace.apis';
import { getPythonApi } from '../../extensionApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { BuiltInEnvironmentManager } from './builtInEnvironmentManager';
import { BuiltInPackageManager } from './builtInPackageManager';
import { PipPackageManager } from './pipPackageManager';
import { SysPythonManager } from './sysPythonManager';
import { UvEnvironmentManager } from './uvEnvironmentManager';
import { UvPackageManager } from './uvPackageManager';
import { VenvEnvironmentManager } from './venvEnvironmentManager';

export async function registerSystemPythonFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    envManager: SysPythonManager,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();
    const venvManager = new BuiltInEnvironmentManager(
        nativeFinder,
        api,
        envManager,
        log,
        new VenvEnvironmentManager(),
        new UvEnvironmentManager(),
    );
    const uvPackageManager = new UvPackageManager(api, log, venvManager);
    const pipPackageManager = new PipPackageManager(api, log, venvManager);
    const pkgManager = new BuiltInPackageManager(pipPackageManager, uvPackageManager);

    disposables.push(
        api.registerPackageManager(pkgManager),
        api.registerPackageManager(uvPackageManager),
        api.registerEnvironmentManager(envManager),
        api.registerEnvironmentManager(venvManager),
    );

    const venvDebouncedRefresh = createSimpleDebounce(500, () => {
        venvManager.watcherRefresh();
    });
    const activationWatcher = createFileSystemWatcher('{**/activate}', false, false, false);
    // Deleting a folder is reported for the folder only, not for the files in it, so deleting a
    // virtual environment folder never matches the activate script pattern above.
    const deletionWatcher = createFileSystemWatcher('**/*', true, true, false);
    disposables.push(
        activationWatcher,
        activationWatcher.onDidCreate(() => {
            venvDebouncedRefresh.trigger();
        }),
        activationWatcher.onDidChange(() => {
            venvDebouncedRefresh.trigger();
        }),
        activationWatcher.onDidDelete(() => {
            venvDebouncedRefresh.trigger();
        }),
        deletionWatcher,
        deletionWatcher.onDidDelete((uri) => {
            if (venvManager.hasEnvironmentAt(uri.fsPath)) {
                venvDebouncedRefresh.trigger();
            }
        }),
        onDidDeleteFiles(() => {
            venvDebouncedRefresh.trigger();
        }),
    );
}
