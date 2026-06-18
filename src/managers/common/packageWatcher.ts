import * as path from 'path';
import { Disposable, LogOutputChannel, RelativePattern, Uri } from 'vscode';
import { EnvironmentManager, PackageManager, PythonEnvironment } from '../../api';
import { traceVerbose } from '../../common/logging';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { createFileSystemWatcher } from '../../common/workspace.apis';

function getWatchTargets(env: PythonEnvironment): RelativePattern[] {
    if (!env.sysPrefix) return [];
    const targets: RelativePattern[] = [];

    if (process.platform === 'win32') {
        targets.push(
            new RelativePattern(Uri.file(path.join(env.sysPrefix, 'Lib')), 'site-packages/**/*.dist-info/METADATA'),
        );
    } else {
        targets.push(
            new RelativePattern(
                Uri.file(path.join(env.sysPrefix, 'lib')),
                'python*/site-packages/**/*.dist-info/METADATA',
            ),
        );
    }

    // Conda
    targets.push(new RelativePattern(Uri.file(path.join(env.sysPrefix, 'conda-meta')), '**/*.json'));

    return targets;
}

export function watchPackageChangesForEnvironment(
    env: PythonEnvironment,
    packageManager: PackageManager,
    log: LogOutputChannel,
): Disposable {
    // Watch targets
    const watchTargets = getWatchTargets(env);
    if (watchTargets.length === 0) {
        traceVerbose(log, `No watch targets for environment ${env.envId}`);
        return new Disposable(() => undefined);
    }
    // Debounced refresh function
    const debouncedRefresh = createSimpleDebounce(500, async () => {
        console.log(`Package change detected for environment ${env.envId}, refreshing packages...`);
        packageManager.refresh(env).catch((ex) => {
            log.error(
                `Failed to refresh packages for environment ${env.envId}: ${ex instanceof Error ? ex.message : String(ex)}`,
            );
        });
    });
    // Create watchers
    const disposables: Disposable[] = [];
    for (const target of watchTargets) {
        const watcher = createFileSystemWatcher(
            target,
            true, // create   -> install
            false, // change   -> ignore
            true, // delete   -> uninstall
        );
        disposables.push(
            watcher,
            watcher.onDidCreate(debouncedRefresh.trigger),
            watcher.onDidDelete(debouncedRefresh.trigger),
        );
    }

    return new Disposable(() => disposables.forEach((d) => d.dispose()));
}

/**
 * Registers package file watchers for all environments managed by the given manager.
 *
 * This is project-agnostic: if a manager discovers an environment, we watch it.
 */
export async function registerPackageWatcherForManager(
    envManager: EnvironmentManager,
    packageManager: PackageManager,
    log: LogOutputChannel,
): Promise<Disposable> {
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
        if (changes.old) {
            removeWatcher(changes.old.envId.id);
        }
    });

    return new Disposable(() => {
        envChangeDisposable?.dispose();
        watchers.forEach((watcher) => watcher.dispose());
        watchers.clear();
    });
}
