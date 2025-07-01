import { Disposable, FileSystemWatcher } from 'vscode';
import { PythonEnvironment } from '../../api';
import { traceError, traceInfo, traceVerbose } from '../../common/logging';
import { createFileSystemWatcher } from '../../common/workspace.apis';
import { EnvironmentManagers, InternalDidChangeEnvironmentsEventArgs, InternalPackageManager } from '../../internal.api';
import { resolveSitePackagesPath } from './sitePackagesUtils';

/**
 * Manages file system watchers for site-packages directories across all Python environments.
 * Automatically refreshes package lists when packages are installed or uninstalled.
 */
export class SitePackagesWatcherService implements Disposable {
    private readonly watchers = new Map<string, FileSystemWatcher>();
    private readonly disposables: Disposable[] = [];

    constructor(private readonly environmentManagers: EnvironmentManagers) {
        this.initializeService();
    }

    /**
     * Initializes the service by setting up event listeners and creating watchers for existing environments.
     */
    private initializeService(): void {
        traceInfo('SitePackagesWatcherService: Initializing automatic package refresh service');

        // Listen for environment changes
        this.disposables.push(
            this.environmentManagers.onDidChangeEnvironments(this.handleEnvironmentChanges.bind(this))
        );

        // Set up watchers for existing environments
        this.setupWatchersForExistingEnvironments();
    }

    /**
     * Sets up watchers for all existing environments.
     */
    private async setupWatchersForExistingEnvironments(): Promise<void> {
        try {
            const managers = this.environmentManagers.managers;
            for (const manager of managers) {
                try {
                    const environments = await manager.getEnvironments('all');
                    for (const environment of environments) {
                        await this.addWatcherForEnvironment(environment);
                    }
                } catch (error) {
                    traceError(`Failed to get environments from manager ${manager.id}:`, error);
                }
            }
        } catch (error) {
            traceError('Failed to setup watchers for existing environments:', error);
        }
    }

    /**
     * Handles environment changes by adding or removing watchers as needed.
     */
    private async handleEnvironmentChanges(event: InternalDidChangeEnvironmentsEventArgs): Promise<void> {
        for (const change of event.changes) {
            try {
                switch (change.kind) {
                    case 'add':
                        await this.addWatcherForEnvironment(change.environment);
                        break;
                    case 'remove':
                        this.removeWatcherForEnvironment(change.environment);
                        break;
                }
            } catch (error) {
                traceError(`Error handling environment change for ${change.environment.displayName}:`, error);
            }
        }
    }

    /**
     * Adds a file system watcher for the given environment's site-packages directory.
     */
    private async addWatcherForEnvironment(environment: PythonEnvironment): Promise<void> {
        const envId = environment.envId.id;
        
        // Check if we already have a watcher for this environment
        if (this.watchers.has(envId)) {
            traceVerbose(`Watcher already exists for environment: ${environment.displayName}`);
            return;
        }

        try {
            const sitePackagesUri = await resolveSitePackagesPath(environment);
            if (!sitePackagesUri) {
                traceVerbose(`Could not resolve site-packages path for environment: ${environment.displayName}`);
                return;
            }

            const pattern = `${sitePackagesUri.fsPath}/**`;
            const watcher = createFileSystemWatcher(
                pattern,
                false, // don't ignore create events
                false, // don't ignore change events  
                false  // don't ignore delete events
            );

            // Set up event handlers
            watcher.onDidCreate(() => this.onSitePackagesChange(environment));
            watcher.onDidChange(() => this.onSitePackagesChange(environment));
            watcher.onDidDelete(() => this.onSitePackagesChange(environment));

            this.watchers.set(envId, watcher);
            traceInfo(`Created site-packages watcher for environment: ${environment.displayName} at ${sitePackagesUri.fsPath}`);

        } catch (error) {
            traceError(`Failed to create watcher for environment ${environment.displayName}:`, error);
        }
    }

    /**
     * Removes the file system watcher for the given environment.
     */
    private removeWatcherForEnvironment(environment: PythonEnvironment): void {
        const envId = environment.envId.id;
        const watcher = this.watchers.get(envId);
        
        if (watcher) {
            watcher.dispose();
            this.watchers.delete(envId);
            traceInfo(`Removed site-packages watcher for environment: ${environment.displayName}`);
        }
    }

    /**
     * Handles site-packages changes by triggering a package refresh.
     */
    private async onSitePackagesChange(environment: PythonEnvironment): Promise<void> {
        try {
            traceVerbose(`Site-packages changed for environment: ${environment.displayName}, triggering package refresh`);
            
            // Get the package manager for this environment
            const packageManager = this.getPackageManagerForEnvironment(environment);
            if (packageManager) {
                // Trigger refresh asynchronously to avoid blocking file system events
                setImmediate(async () => {
                    try {
                        await packageManager.refresh(environment);
                        traceInfo(`Package list refreshed automatically for environment: ${environment.displayName}`);
                    } catch (error) {
                        traceError(`Failed to refresh packages for environment ${environment.displayName}:`, error);
                    }
                });
            } else {
                traceVerbose(`No package manager found for environment: ${environment.displayName}`);
            }
        } catch (error) {
            traceError(`Error handling site-packages change for environment ${environment.displayName}:`, error);
        }
    }

    /**
     * Gets the appropriate package manager for the given environment.
     */
    private getPackageManagerForEnvironment(environment: PythonEnvironment): InternalPackageManager | undefined {
        try {
            // Try to get package manager by environment manager's preferred package manager
            const envManager = this.environmentManagers.managers.find(m => 
                m.id === environment.envId.managerId
            );
            
            if (envManager) {
                return this.environmentManagers.getPackageManager(envManager.preferredPackageManagerId);
            }

            // Fallback to default package manager
            return this.environmentManagers.getPackageManager(environment);
        } catch (error) {
            traceError(`Error getting package manager for environment ${environment.displayName}:`, error);
            return undefined;
        }
    }

    /**
     * Disposes all watchers and cleans up resources.
     */
    dispose(): void {
        traceInfo('SitePackagesWatcherService: Disposing automatic package refresh service');
        
        // Dispose all watchers
        for (const watcher of this.watchers.values()) {
            watcher.dispose();
        }
        this.watchers.clear();

        // Dispose event listeners
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }
}