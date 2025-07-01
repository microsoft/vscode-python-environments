import { Disposable, FileSystemWatcher } from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { PythonEnvironment, PackageManager } from '../api';
import { createFileSystemWatcher } from './workspace.apis';
import { createSimpleDebounce } from './utils/debounce';

/**
 * Resolves the site-packages directory path for a Python environment
 */
export function getSitePackagesPath(environment: PythonEnvironment): string | undefined {
    if (!environment.sysPrefix) {
        return undefined;
    }

    const platform = os.platform();
    
    if (platform === 'win32') {
        // Windows: <sysPrefix>/Lib/site-packages
        return path.join(environment.sysPrefix, 'Lib', 'site-packages');
    } else {
        // Linux/Mac: <sysPrefix>/lib/python*/site-packages
        // We'll use a glob pattern to match python version directories
        return path.join(environment.sysPrefix, 'lib', 'python*', 'site-packages');
    }
}

/**
 * Service to manage file system watchers for package directories
 */
export class PackageWatcherService implements Disposable {
    private watchers = new Map<string, { watcher: FileSystemWatcher; count: number; disposables: Disposable[] }>();
    private envToPath = new Map<string, string>();
    private pathToManagers = new Map<string, Set<{ env: PythonEnvironment; manager: PackageManager }>>();

    /**
     * Starts watching the site-packages directory for an environment
     */
    watchEnvironment(environment: PythonEnvironment, manager: PackageManager): Disposable {
        const sitePackagesPath = getSitePackagesPath(environment);
        if (!sitePackagesPath) {
            // Return empty disposable if we can't determine site-packages path
            return new Disposable(() => {});
        }

        const envId = environment.envId.id;
        this.envToPath.set(envId, sitePackagesPath);

        // Get or create managers set for this path
        if (!this.pathToManagers.has(sitePackagesPath)) {
            this.pathToManagers.set(sitePackagesPath, new Set());
        }
        const managers = this.pathToManagers.get(sitePackagesPath)!;
        managers.add({ env: environment, manager });

        // Create or reuse watcher
        const existingWatcher = this.watchers.get(sitePackagesPath);
        if (existingWatcher) {
            existingWatcher.count++;
        } else {
            // Create debounced refresh function
            const debouncedRefresh = createSimpleDebounce(1000, () => {
                this.refreshPackagesForPath(sitePackagesPath);
            });

            // Create file system watcher for the site-packages directory
            // Watch for file creation and deletion (packages being installed/uninstalled)
            const watcher = createFileSystemWatcher(
                `${sitePackagesPath}/**`,
                false, // don't ignore create events
                true,  // ignore change events (we only care about install/uninstall)
                false  // don't ignore delete events
            );

            // Set up event handlers
            const createDisposable = watcher.onDidCreate(() => {
                debouncedRefresh.trigger();
            });
            
            const deleteDisposable = watcher.onDidDelete(() => {
                debouncedRefresh.trigger();
            });

            this.watchers.set(sitePackagesPath, {
                watcher,
                count: 1,
                disposables: [createDisposable, deleteDisposable]
            });
        }

        // Return disposable to stop watching this environment
        return new Disposable(() => {
            this.unwatchEnvironment(environment, manager);
        });
    }

    private unwatchEnvironment(environment: PythonEnvironment, manager: PackageManager): void {
        const envId = environment.envId.id;
        const sitePackagesPath = this.envToPath.get(envId);
        
        if (!sitePackagesPath) {
            return;
        }

        this.envToPath.delete(envId);

        // Remove from managers set
        const managers = this.pathToManagers.get(sitePackagesPath);
        if (managers) {
            // Find and remove the specific environment/manager combination
            for (const item of managers) {
                if (item.env.envId.id === envId && item.manager === manager) {
                    managers.delete(item);
                    break;
                }
            }

            // If no more managers for this path, clean up
            if (managers.size === 0) {
                this.pathToManagers.delete(sitePackagesPath);
            }
        }

        // Decrement watcher count and dispose if no longer needed
        const watcherInfo = this.watchers.get(sitePackagesPath);
        if (watcherInfo) {
            watcherInfo.count--;
            if (watcherInfo.count <= 0) {
                watcherInfo.watcher.dispose();
                watcherInfo.disposables.forEach(d => d.dispose());
                this.watchers.delete(sitePackagesPath);
            }
        }
    }

    private async refreshPackagesForPath(sitePackagesPath: string): Promise<void> {
        const managers = this.pathToManagers.get(sitePackagesPath);
        if (!managers) {
            return;
        }

        // Refresh packages for all environments using this site-packages path
        const refreshPromises: Promise<void>[] = [];
        for (const { env, manager } of managers) {
            refreshPromises.push(manager.refresh(env).catch(() => {
                // Ignore errors during refresh to prevent one environment from blocking others
            }));
        }

        await Promise.all(refreshPromises);
    }

    dispose(): void {
        // Dispose all watchers
        for (const { watcher, disposables } of this.watchers.values()) {
            watcher.dispose();
            disposables.forEach(d => d.dispose());
        }
        this.watchers.clear();
        this.envToPath.clear();
        this.pathToManagers.clear();
    }
}