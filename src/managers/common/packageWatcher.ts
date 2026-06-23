import * as path from 'path';
import { Disposable, LogOutputChannel, RelativePattern } from 'vscode';
import { EnvironmentManager, PackageManager, PythonEnvironment } from '../../api';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { createFileSystemWatcher, getConfiguration } from '../../common/workspace.apis';

/**
 * Derives the file system watch targets for a given Python environment.
 *
 * Targets include site-packages `.dist-info/METADATA` files for pip-style installs.
 *
 * @param env - The Python environment to derive watch targets for.
 * @returns An array of RelativePattern objects, one per discoverable package location.
 *          Empty if the environment has no `sysPrefix` or discoverable paths.
 */
function getDefaultPackageWatchTargets(env: PythonEnvironment): RelativePattern[] {
    if (!env.sysPrefix) {
        return [];
    }
    return process.platform === 'win32'
        ? [new RelativePattern(path.join(env.sysPrefix, 'Lib'), 'site-packages/**/*.dist-info/METADATA')] // Windows
        : [new RelativePattern(path.join(env.sysPrefix, 'lib'), 'python*/site-packages/**/*.dist-info/METADATA')]; // Unix-like
}

/**
 * Creates a file system watcher for package changes in a single environment.
 *
 * Monitors default site-packages locations and any manager-specific extra locations
 * for install/uninstall operations.
 * and triggers a debounced package refresh when changes are detected.
 *
 * @param env - The Python environment to watch.
 * @param packageManager - The package manager to call refresh on when changes occur.
 * @param log - Logger for diagnostic messages.
 * @returns A disposable that removes the watcher when disposed.
 */
export function watchPackageChangesForEnvironment(
    env: PythonEnvironment,
    packageManager: PackageManager,
    log: LogOutputChannel,
): Disposable {
    // Watch targets
    const watchTargets = [
        ...getDefaultPackageWatchTargets(env),
        ...(packageManager.getPackageWatchTargets?.(env) ?? []),
    ];
    if (watchTargets.length === 0) {
        log.debug(`No watch targets for environment ${env.envId.id}`);
        return new Disposable(() => undefined);
    }
    // Debounced refresh function
    const debouncedRefresh = createSimpleDebounce(500, async () => {
        log.debug(`Package change detected for environment ${env.envId.id}, refreshing packages.`);
        packageManager.refresh(env).catch((ex) => {
            log.error(
                `Failed to refresh packages for environment ${env.envId.id}: ${ex instanceof Error ? ex.message : String(ex)}`,
            );
        });
    });
    // Create watchers
    const disposables: Disposable[] = [debouncedRefresh];
    const trigger = debouncedRefresh.trigger.bind(debouncedRefresh);
    for (const target of watchTargets) {
        const watcher = createFileSystemWatcher(
            target,
            false, // create   -> install
            true, // change   -> ignore
            false, // delete   -> uninstall
        );
        disposables.push(
            watcher,
            watcher.onDidCreate(trigger),
            watcher.onDidDelete(trigger),
        );
    }

    return new Disposable(() => disposables.forEach((d) => d.dispose()));
}

/**
 * Registers automatic file system watchers for the active environment managed by a given manager.
 *
 * Creates per-environment watchers that are attached when the active environment changes
 * and detached when it changes to a different environment. Ensures package changes
 * (installs/uninstalls) in the active environment are detected and trigger a refresh.
 *
 * @param envManager - The environment manager whose active environment should be watched.
 * @param packageManager - The package manager to call refresh on when changes occur.
 * @param log - Logger for diagnostic and error messages.
 * @returns A disposable that removes all watchers and subscriptions when disposed.
 */
export function registerPackageWatcherForManager(
    envManager: EnvironmentManager,
    packageManager: PackageManager,
    log: LogOutputChannel,
): Disposable {
    const packageWatchersEnabled = getConfiguration('python-envs').get<boolean>('packageWatchers', true);
    if (!packageWatchersEnabled) {
        return new Disposable(() => undefined);
    }

    // One watcher per environment id.
    const watchers = new Map<string, Disposable>();

    const addWatcher = (env: PythonEnvironment): void => {
        if (!watchers.has(env.envId.id)) {
            watchers.set(env.envId.id, watchPackageChangesForEnvironment(env, packageManager, log));
        }
    };

    const removeWatcher = (envId: string): void => {
        watchers.get(envId)?.dispose();
        watchers.delete(envId);
    };

    const envChangeDisposable = envManager.onDidChangeEnvironment?.((changes) => {
        if (changes.new) {
            addWatcher(changes.new);
        }
        if (changes.old && changes.old.envId.id !== changes.new?.envId.id) {
            removeWatcher(changes.old.envId.id);
        }
    });

    return new Disposable(() => {
        envChangeDisposable?.dispose();
        watchers.forEach((watcher) => watcher.dispose());
        watchers.clear();
    });
}
