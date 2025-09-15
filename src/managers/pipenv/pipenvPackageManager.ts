import * as cp from 'child_process';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import {
    CancellationError,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
} from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import {
    DidChangePackagesEventArgs,
    IconPath,
    Package,
    PackageChangeKind,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { showErrorMessage, withProgress } from '../../common/window.apis';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PipenvManager } from './pipenvManager';
import { getPipenv } from './pipenvUtils';

const exec = promisify(cp.exec);

function getChanges(before: Package[], after: Package[]): { kind: PackageChangeKind; pkg: Package }[] {
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];
    before.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.remove, pkg });
    });
    after.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.add, pkg });
    });
    return changes;
}

export class PipenvPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        _pipenv: PipenvManager,
        private readonly nativeFinder: NativePythonFinder,
    ) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.tooltip = new MarkdownString('Manages packages using `pipenv`', true);
        this.iconPath = new ThemeIcon('package');
    }

    name: string;
    displayName: string;
    description?: string;
    tooltip: string | MarkdownString;
    iconPath?: IconPath;

    dispose(): void {
        this._onDidChangePackages.dispose();
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: `Refreshing packages for ${environment.displayName}`,
            },
            async () => {
                try {
                    const after = await this.refreshPackages(environment);
                    this.packages.set(environment.envId.id, after);
                } catch (error) {
                    this.log.error(`Failed to refresh packages: ${error}`);
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        const packages = this.packages.get(environment.envId.id);
        if (packages) {
            return packages;
        }

        return this.refreshPackages(environment);
    }

    async refreshPackages(environment: PythonEnvironment): Promise<Package[]> {
        const before = this.packages.get(environment.envId.id) || [];

        try {
            const packages = await this.getPackagesFromEnvironment(environment);
            this.packages.set(environment.envId.id, packages);

            const changes = getChanges(before, packages);
            if (changes.length > 0) {
                this._onDidChangePackages.fire({ environment, manager: this, changes });
            }

            return packages;
        } catch (error) {
            this.log.error(`Failed to refresh packages for ${environment.displayName}: ${error}`);
            return before;
        }
    }

    private async getPackagesFromEnvironment(environment: PythonEnvironment): Promise<Package[]> {
        const pipenvPath = await getPipenv(this.nativeFinder);
        if (!pipenvPath) {
            throw new Error('Pipenv not found');
        }

        try {
            // Get the project path from the environment
            const projectPath = await this.getProjectPathFromEnvironment(environment);
            
            // Run pipenv graph to get package information
            const { stdout } = await exec(`"${pipenvPath}" graph --json`, {
                cwd: projectPath,
            });

            if (!stdout) {
                return [];
            }

            const packageData = JSON.parse(stdout);
            const packages: Package[] = [];

            // Parse the graph output
            for (const pkg of packageData) {
                packages.push(this.api.createPackageItem({
                    name: pkg.package.package_name,
                    displayName: pkg.package.package_name,
                    version: pkg.package.installed_version,
                    description: pkg.package.package_name, // Pipenv graph doesn't provide summary
                }, environment, this));
            }

            return packages;
        } catch (error) {
            this.log.error(`Failed to get packages from pipenv: ${error}`);
            return [];
        }
    }

    private async getProjectPathFromEnvironment(environment: PythonEnvironment): Promise<string | undefined> {
        // Try to find the project that this environment belongs to
        const projects = this.api.getPythonProjects();
        for (const project of projects) {
            const env = await this.api.getEnvironment(project.uri);
            if (env && env.envId.id === environment.envId.id) {
                return project.uri.fsPath;
            }
        }

        // Fallback: assume the environment is in a project directory
        // For pipenv, the project is typically where the Pipfile is located
        let currentPath = path.dirname(environment.environmentPath.fsPath);
        
        // Search up the directory tree for a Pipfile
        while (currentPath !== path.dirname(currentPath)) {
            const pipfilePath = path.join(currentPath, 'Pipfile');
            if (await fsapi.pathExists(pipfilePath)) {
                return currentPath;
            }
            currentPath = path.dirname(currentPath);
        }

        return undefined;
    }

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        const pipenvPath = await getPipenv(this.nativeFinder);
        if (!pipenvPath) {
            await showErrorMessage('Pipenv not found. Please install pipenv first.');
            return;
        }

        const projectPath = await this.getProjectPathFromEnvironment(environment);
        if (!projectPath) {
            await showErrorMessage('Could not find project path for pipenv environment.');
            return;
        }

        if (options.install && options.install.length > 0) {
            await this.installPackages(environment, options.install, projectPath, pipenvPath);
        }

        if (options.uninstall && options.uninstall.length > 0) {
            await this.uninstallPackages(environment, options.uninstall, projectPath, pipenvPath);
        }
    }

    private async installPackages(
        environment: PythonEnvironment,
        packages: string[],
        projectPath: string,
        pipenvPath: string,
    ): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: `Installing packages in ${environment.displayName}`,
                cancellable: true,
            },
            async (progress, token) => {
                for (let i = 0; i < packages.length; i++) {
                    if (token.isCancellationRequested) {
                        throw new CancellationError();
                    }

                    const pkg = packages[i];
                    progress.report({
                        message: `Installing ${pkg} (${i + 1}/${packages.length})`,
                        increment: (100 / packages.length),
                    });

                    try {
                        const { stderr } = await exec(`"${pipenvPath}" install ${pkg}`, {
                            cwd: projectPath,
                        });

                        if (stderr && stderr.includes('ERROR')) {
                            this.log.error(`Failed to install ${pkg}: ${stderr}`);
                        } else {
                            this.log.info(`Successfully installed ${pkg}`);
                        }
                    } catch (error) {
                        this.log.error(`Failed to install ${pkg}: ${error}`);
                    }
                }

                // Refresh packages after installation
                await this.refreshPackages(environment);
            },
        );
    }

    private async uninstallPackages(
        environment: PythonEnvironment,
        packages: string[],
        projectPath: string,
        pipenvPath: string,
    ): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: `Uninstalling packages from ${environment.displayName}`,
                cancellable: true,
            },
            async (progress, token) => {
                for (let i = 0; i < packages.length; i++) {
                    if (token.isCancellationRequested) {
                        throw new CancellationError();
                    }

                    const pkg = packages[i];
                    progress.report({
                        message: `Uninstalling ${pkg} (${i + 1}/${packages.length})`,
                        increment: (100 / packages.length),
                    });

                    try {
                        const { stderr } = await exec(`"${pipenvPath}" uninstall ${pkg}`, {
                            cwd: projectPath,
                        });

                        if (stderr && stderr.includes('ERROR')) {
                            this.log.error(`Failed to uninstall ${pkg}: ${stderr}`);
                        } else {
                            this.log.info(`Successfully uninstalled ${pkg}`);
                        }
                    } catch (error) {
                        this.log.error(`Failed to uninstall ${pkg}: ${error}`);
                    }
                }

                // Refresh packages after uninstallation
                await this.refreshPackages(environment);
            },
        );
    }
}