import * as path from 'path';
import { promises as fs } from 'fs';
import { Disposable, Event, LogOutputChannel, RelativePattern, Terminal, Uri } from 'vscode';
import { PackageManager, PythonEnvironment } from '../../api';
import { traceWarn } from '../../common/logging';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { normalizePath } from '../../common/utils/pathUtils';
import { onDidCloseTerminal } from '../../common/window.apis';
import { pathExists } from '../../common/workspace.fs.apis';
import { createFileSystemWatcher, getConfiguration, onDidChangeConfiguration } from '../../common/workspace.apis';
import type { EnvironmentManagers } from '../../features/envManagers';

const pausedRuntimePrefixes = new Map<string, number>();
const runtimeWatcherPauseListeners = new Set<() => Promise<void>>();

async function reconcileRuntimeWatchers(): Promise<void> {
    await Promise.all([...runtimeWatcherPauseListeners].map((listener) => listener()));
}

/**
 * Releases this extension's package watchers while an installer replaces a base runtime.
 * Windows cannot rename an installation containing a watched directory.
 * @param prefix The physically resolved runtime prefix.
 * @param operation The approved installation and verification operation.
 * @returns The operation result, restoring watchers even on failure or cancellation.
 */
export async function withPackageWatchersPaused<T>(prefix: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizePath(path.resolve(prefix));
    pausedRuntimePrefixes.set(key, (pausedRuntimePrefixes.get(key) ?? 0) + 1);
    try {
        await reconcileRuntimeWatchers();
        return await operation();
    } finally {
        const remaining = (pausedRuntimePrefixes.get(key) ?? 1) - 1;
        if (remaining === 0) {
            pausedRuntimePrefixes.delete(key);
        } else {
            pausedRuntimePrefixes.set(key, remaining);
        }
        await reconcileRuntimeWatchers().catch((error) => {
            traceWarn('Could not restore package watchers after Python installation:', error);
        });
    }
}

export interface PackageWatcherTerminalActivation {
    onDidChangeTerminalActivationState: Event<{
        terminal: Terminal;
        environment: PythonEnvironment;
        activated: boolean;
    }>;
}

const MAX_MISSING_EXECUTABLE_REFRESH_RETRIES = 60;

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
 * @param resolvePackageManager - Resolves the current package manager before each refresh.
 * @returns A disposable that removes the watcher when disposed.
 */
export function watchPackageChangesForEnvironment(
    env: PythonEnvironment,
    packageManager: PackageManager,
    log: LogOutputChannel,
    resolvePackageManager: () => PackageManager | undefined = () => packageManager,
): Disposable {
    const watchTargets = [
        ...getDefaultPackageWatchTargets(env),
        ...(packageManager.getPackageWatchTargets?.(env) ?? []),
    ];
    if (watchTargets.length === 0) {
        log.debug(`No watch targets for environment ${env.envId.id}`);
        return new Disposable(() => undefined);
    }

    let missingExecutableRefreshRetries = 0;
    const debouncedRefresh = createSimpleDebounce(500, () => {
        void (async () => {
            try {
                if (!(await pathExists(Uri.file(env.execInfo.run.executable)))) {
                    if (missingExecutableRefreshRetries < MAX_MISSING_EXECUTABLE_REFRESH_RETRIES) {
                        missingExecutableRefreshRetries += 1;
                        debouncedRefresh.trigger();
                    } else {
                        log.debug(
                            `Package change detected for environment ${env.envId.id}, but its executable did not reappear. Skipping package refresh.`,
                        );
                    }
                    return;
                }
            } catch (ex) {
                log.error(
                    `Failed to check the executable for environment ${env.envId.id}: ${ex instanceof Error ? ex.message : String(ex)}`,
                );
                return;
            }

            missingExecutableRefreshRetries = 0;
            log.debug(`Package change detected for environment ${env.envId.id}, refreshing packages.`);
            const currentPackageManager = resolvePackageManager();
            if (!currentPackageManager) {
                log.debug(`No current package manager found for environment ${env.envId.id}`);
                return;
            }
            try {
                await currentPackageManager.refresh(env);
            } catch (ex) {
                log.error(
                    `Failed to refresh packages for environment ${env.envId.id}: ${ex instanceof Error ? ex.message : String(ex)}`,
                );
            }
        })();
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
    interface DesiredWatcher {
        readonly context: Uri | PythonEnvironment | undefined;
        readonly environment: PythonEnvironment;
        prefixKey: Promise<string | undefined>;
    }
    const activeWatcherByConsumer = new Map<WatcherConsumer, string>();
    const desiredWatchers = new Map<WatcherConsumer, DesiredWatcher>();
    const activeEnvironmentByScope = new Map<
        string,
        { scope: Uri | undefined; environment: PythonEnvironment }
    >();
    const sharedWatchers = new Map<
        string,
        { disposable: Disposable; references: number; prefixKey: Promise<string | undefined> }
    >();
    const closedTerminals = new WeakSet<Terminal>();
    let disposed = false;

    const resolvePrefixKey = async (prefix: string): Promise<string | undefined> => {
        if (!prefix) {
            return undefined;
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            const physical = await Promise.race([
                fs.realpath(prefix),
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error('Package watcher prefix resolution timed out.')), 1000);
                }),
            ]);
            return normalizePath(physical);
        } catch (error) {
            if (!disposed) {
                log.warn(`Could not resolve package watcher prefix; it will be paused conservatively during runtime updates: ${error}`);
            }
            return undefined;
        } finally {
            clearTimeout(deadline);
        }
    };

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

    const attachWatcher = (
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

        const packageManagerKey =
            `${selectedPackageManager.id}:${selectedPackageManager.project?.uri.toString() ?? ''}`;
        const watcherKey = `${environment.envId.managerId}:${environment.envId.id}:${packageManagerKey}`;
        const desired = desiredWatchers.get(consumer);
        const sharedWatcher = sharedWatchers.get(watcherKey);
        if (desired && sharedWatcher) {
            desired.prefixKey = sharedWatcher.prefixKey;
        }
        if (activeWatcherByConsumer.get(consumer) === watcherKey) {
            return;
        }

        releaseConsumer(consumer);

        if (sharedWatcher) {
            sharedWatcher.references += 1;
        } else {
            const resolvePackageManager = () => {
                const currentPackageManager =
                    envManagers.getPackageManager(packageManagerContext) ?? envManagers.getPackageManager(environment);
                if (
                    selectedPackageManager.project &&
                    currentPackageManager?.project?.uri.toString() !== selectedPackageManager.project.uri.toString()
                ) {
                    return undefined;
                }
                return currentPackageManager;
            };
            sharedWatchers.set(watcherKey, {
                disposable: watchPackageChangesForEnvironment(
                    environment,
                    selectedPackageManager,
                    log,
                    resolvePackageManager,
                ),
                references: 1,
                prefixKey: desired?.prefixKey ?? resolvePrefixKey(environment.sysPrefix),
            });
        }
        activeWatcherByConsumer.set(consumer, watcherKey);
    };

    const reconcileConsumer = async (consumer: WatcherConsumer, desired: DesiredWatcher): Promise<void> => {
        const prefixKey = await desired.prefixKey;
        if (disposed || desiredWatchers.get(consumer) !== desired) {
            return;
        }
        if (pausedRuntimePrefixes.size > 0 && (!prefixKey || pausedRuntimePrefixes.has(prefixKey))) {
            releaseConsumer(consumer);
        } else {
            attachWatcher(consumer, desired.context, desired.environment);
        }
    };

    const watchEnvironment = (
        consumer: WatcherConsumer,
        context: Uri | PythonEnvironment | undefined,
        environment: PythonEnvironment,
    ): void => {
        const previous = desiredWatchers.get(consumer);
        const desired: DesiredWatcher = {
            context,
            environment,
            prefixKey: previous?.environment === environment
                ? previous.prefixKey
                : resolvePrefixKey(environment.sysPrefix),
        };
        desiredWatchers.set(consumer, desired);
        if (pausedRuntimePrefixes.size > 0) {
            // Do not create an alias-spelled watcher while its physical identity is pending.
            releaseConsumer(consumer);
            void reconcileConsumer(consumer, desired).catch((error) => {
                log.error(`Could not reconcile package watchers during Python installation: ${error}`);
            });
        } else {
            attachWatcher(consumer, context, environment);
        }
    };

    const environmentChangeDisposable = envManagers.onDidChangeActiveEnvironment((changes) => {
        const scopeKey = changes.uri?.toString() ?? 'global';
        if (changes.new) {
            activeEnvironmentByScope.set(scopeKey, { scope: changes.uri, environment: changes.new });
            watchEnvironment(scopeKey, changes.uri, changes.new);
        } else {
            activeEnvironmentByScope.delete(scopeKey);
            desiredWatchers.delete(scopeKey);
            releaseConsumer(scopeKey);
        }
    });

    const terminalActivationDisposable = terminalActivation.onDidChangeTerminalActivationState((changes) => {
        if (changes.activated) {
            if (!closedTerminals.has(changes.terminal)) {
                const projectScope = Array.from(activeEnvironmentByScope.values()).find(
                    ({ scope, environment }) =>
                        scope &&
                        environment.envId.id === changes.environment.envId.id &&
                        environment.envId.managerId === changes.environment.envId.managerId,
                )?.scope;
                const managerContext = projectScope ?? changes.environment;
                const packageManager = envManagers.getPackageManager(managerContext);
                if (!projectScope && packageManager?.createForProject) {
                    releaseConsumer(changes.terminal);
                    log.debug(
                        `Skipping unscoped package watcher for project-aware manager ${packageManager.id}`,
                    );
                    return;
                }
                watchEnvironment(changes.terminal, managerContext, changes.environment);
            }
        } else {
            desiredWatchers.delete(changes.terminal);
            releaseConsumer(changes.terminal);
        }
    });

    const terminalCloseDisposable = onDidCloseTerminal((terminal) => {
        closedTerminals.add(terminal);
        desiredWatchers.delete(terminal);
        releaseConsumer(terminal);
    });

    const reconcile = async (): Promise<void> => {
        await Promise.all([...desiredWatchers].map(([consumer, desired]) => reconcileConsumer(consumer, desired)));
    };
    runtimeWatcherPauseListeners.add(reconcile);

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
        disposed = true;
        environmentChangeDisposable.dispose();
        terminalActivationDisposable.dispose();
        terminalCloseDisposable.dispose();
        configurationChangeDisposable.dispose();
        runtimeWatcherPauseListeners.delete(reconcile);
        sharedWatchers.forEach(({ disposable }) => disposable.dispose());
        sharedWatchers.clear();
        activeWatcherByConsumer.clear();
        activeEnvironmentByScope.clear();
        desiredWatchers.clear();
    });
}
