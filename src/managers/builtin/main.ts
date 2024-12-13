import { Disposable, LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { SysPythonManager } from './sysPythonManager';
import { PipPackageManager } from './pipManager';
import { VenvManager } from './venvManager';
import { getPythonApi } from '../../features/pythonApi';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { UvProjectCreator } from './uvProjectCreator';
import { isUvInstalled } from './helpers';
import { createFileSystemWatcher, onDidDeleteFiles } from '../../common/workspace.apis';
import { createSimpleDebounce } from '../../common/utils/debounce';

export async function registerSystemPythonFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
): Promise<void> {
    const api: PythonEnvironmentApi = await getPythonApi();
    const envManager = new SysPythonManager(nativeFinder, api, log);
    const venvManager = new VenvManager(nativeFinder, api, envManager, log);
    const pkgManager = new PipPackageManager(api, log, venvManager);

    disposables.push(
        api.registerPackageManager(pkgManager),
        api.registerEnvironmentManager(envManager),
        api.registerEnvironmentManager(venvManager),
    );

    const venvDebouncedRefresh = createSimpleDebounce(500, () => {
        venvManager.refresh(undefined);
    });
    const watcher = createFileSystemWatcher('{**/pyenv.cfg,**/bin/python,**/python.exe}', false, true, false);
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

    setImmediate(async () => {
        if (await isUvInstalled(log)) {
            disposables.push(api.registerPythonProjectCreator(new UvProjectCreator(api, log)));
        }
    });
}
