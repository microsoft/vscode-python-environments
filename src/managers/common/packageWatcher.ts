import * as path from 'path';
import { Disposable, Event, LogOutputChannel, RelativePattern, Terminal, Uri } from 'vscode';
import { PackageManager, PythonEnvironment } from '../../api';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { onDidCloseTerminal } from '../../common/window.apis';
import { createFileSystemWatcher, getConfiguration, onDidChangeConfiguration } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';

export interface PackageWatcherTerminalActivation {
    onDidChangeTerminalActivationState: Event<{
        terminal: Terminal;
        environment: PythonEnvironment;
        activated: boolean;
    }>;
}

/**
 * Derives the file system watch targets for a given Python environment.
 *
 * Targets include site-packages `.dist-info` directories and their contents for pip-style installs.
 *
 * @param env - The Python environment to derive watch targets for.
 * @returns An array of RelativePattern objects, one per discoverable package location.
 *          Empty if the environment has no `sysPrefix` or discoverable paths.
 */
function getDefaultPackageWatchTargets(env: PythonEnvironment): RelativePattern[] {
    if (!env.sysPrefix) {
        return [];
    }

    const isWindows = process.platform === 'win32';
    const libraryPath = path.join(env.sysPrefix, isWindows ? 'Lib' : 'lib');
    const pattern = isWindows
        ? 'site-packages/{*.dist-info,*.dist-info/**}'
        : 'python*/site-packages/{*.dist-info,*.dist-info/**}';
    return [new RelativePattern(libraryPath, pattern)];
}

/**
 * Creates a file system watcher for package changes in a single environment.
 *
 * Monitors default site-packages and manager-specific locations, then triggers a
 * debounced package refresh when changes are detected.
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
    const watchTargets = [
        ...getDefaultPackageWatchTargets(env),
        ...(packageManager.getPackageWatchTargets?.(env) ?? []),
    ];
    if (watchTargets.length === 0) {
        log.debug(`No watch targets for environment ${env.envId.id}`);
        return new Disposable(() => undefined);
    }

    const debouncedRefresh = createSimpleDebounce(500, () => {
        log.debug(`Package change detected for environment ${env.envId.id}, refreshing packages.`);
        void packageManager.refresh(env).catch((ex) => {
            log.error(
                `Failed to refresh packages for environment ${env.envId.id}: ${ex instanceof Error ? ex.message : String(ex)}`,
            );
        });
    });
    const disposables: Disposable[] = [debouncedRefresh];
    const trigger = debouncedRefresh.trigger.bind(debouncedRefresh);

    for (const target of watchTargets) {
        const watcher = createFileSystemWatcher(
            target,
            false, // ignoreCreateEvents
            false, // ignoreChangeEvents
            false, // ignoreDeleteEvents
        );
        log.debug(`Watching for package changes in environment ${env.envId.id} at ${target.pattern}`);
        disposables.push(
            watcher,
            watcher.onDidChange(trigger),
            watcher.onDidCreate(trigger),
            watcher.onDidDelete(trigger),
        );
    }

    return Disposable.from(...disposables);
}

/**
 * Registers package watchers for every active environment, regardless of manager type.
 *
 * A watcher is shared when the same environment is active in multiple scopes and is
 * disposed only after the final scope stops using that environment.
 *
 * @param envManagers - The central environment and package manager registry.
 * @param terminalActivation - Tracks environments activated in terminals.
 * @param log - Logger for diagnostic and error messages.
 * @returns A disposable that removes all watchers and subscriptions when disposed.
 */
export function registerPackageWatchers(
    envManagers: EnvironmentManagers,
    terminalActivation: PackageWatcherTerminalActivation,
    log: LogOutputChannel,
): Disposable {
    const packageWatchersEnabled = getConfiguration('python-envs').get<boolean>('packageWatchers', true);
    if (!packageWatchersEnabled) {
        return new Disposable(() => undefined);
    }

    type WatcherConsumer = string | Terminal;
    const activeWatcherByConsumer = new Map<WatcherConsumer, string>();
    const activeEnvironmentByScope = new Map<
        string,
        { scope: Uri | undefined; environment: PythonEnvironment }
    >();
    const sharedWatchers = new Map<string, { disposable: Disposable; references: number }>();
    const closedTerminals = new WeakSet<Terminal>();

    const releaseConsumer = (consumer: WatcherConsumer): void => {
        const watcherKey = activeWatcherByConsumer.get(consumer);
        if (!watcherKey) {
            return;
        }

        activeWatcherByConsumer.delete(consumer);
        const watcher = sharedWatchers.get(watcherKey);
        if (!watcher) {
            return;
        }

        watcher.references -= 1;
        if (watcher.references === 0) {
            watcher.disposable.dispose();
            sharedWatchers.delete(watcherKey);
        }
    };

    const watchEnvironment = (
        consumer: WatcherConsumer,
        packageManagerContext: Uri | PythonEnvironment | undefined,
        environment: PythonEnvironment,
    ): void => {
        const selectedPackageManager =
            envManagers.getPackageManager(packageManagerContext) ?? envManagers.getPackageManager(environment);
        if (!selectedPackageManager) {
            releaseConsumer(consumer);
            log.debug(`No package manager found for environment ${environment.envId.id}`);
            return;
        }

        const watcherKey = `${environment.envId.managerId}:${environment.envId.id}:${selectedPackageManager.id}`;
        if (activeWatcherByConsumer.get(consumer) === watcherKey) {
            return;
        }

        releaseConsumer(consumer);

        const sharedWatcher = sharedWatchers.get(watcherKey);
        if (sharedWatcher) {
            sharedWatcher.references += 1;
        } else {
            sharedWatchers.set(watcherKey, {
                disposable: watchPackageChangesForEnvironment(environment, selectedPackageManager, log),
                references: 1,
            });
        }
        activeWatcherByConsumer.set(consumer, watcherKey);
    };

    const environmentChangeDisposable = envManagers.onDidChangeActiveEnvironment((changes) => {
        const scopeKey = changes.uri?.toString() ?? 'global';
        if (changes.new) {
            activeEnvironmentByScope.set(scopeKey, { scope: changes.uri, environment: changes.new });
            watchEnvironment(scopeKey, changes.uri, changes.new);
        } else {
            activeEnvironmentByScope.delete(scopeKey);
            releaseConsumer(scopeKey);
        }
    });

    const terminalActivationDisposable = terminalActivation.onDidChangeTerminalActivationState((changes) => {
        if (changes.activated) {
            if (!closedTerminals.has(changes.terminal)) {
                watchEnvironment(changes.terminal, changes.environment, changes.environment);
            }
        } else {
            releaseConsumer(changes.terminal);
        }
    });

    const terminalCloseDisposable = onDidCloseTerminal((terminal) => {
        closedTerminals.add(terminal);
        releaseConsumer(terminal);
    });

    const configurationChangeDisposable = onDidChangeConfiguration((changes) => {
        if (
            !changes.affectsConfiguration('python-envs.defaultPackageManager') &&
            !changes.affectsConfiguration('python-envs.pythonProjects')
        ) {
            return;
        }

        activeEnvironmentByScope.forEach(({ scope, environment }, scopeKey) => {
            watchEnvironment(scopeKey, scope, environment);
        });
    });

    return new Disposable(() => {
        environmentChangeDisposable.dispose();
        terminalActivationDisposable.dispose();
        terminalCloseDisposable.dispose();
        configurationChangeDisposable.dispose();
        sharedWatchers.forEach(({ disposable }) => disposable.dispose());
        sharedWatchers.clear();
        activeWatcherByConsumer.clear();
        activeEnvironmentByScope.clear();
    });
}
