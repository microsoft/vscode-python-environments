import type { Pep440Version } from '@renovatebot/pep440';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import {
    CancellationError,
    CancellationToken,
    Event,
    EventEmitter,
    l10n,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
} from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import {
    DidChangePackagesEventArgs,
    GetPackagesOptions,
    IconPath,
    Package,
    PackageManagementOptions,
    PackageManager,
    PackageVersionLookupNotSupportedError,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../api';
import { showErrorMessage, showInputBox, withProgress } from '../../common/window.apis';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { parsePackageSpecs } from '../common/packageUtils';
import {
    PoetryAddCommand,
    PoetryRemoveCommand,
    PoetryShowCommand,
    PoetryShowTopLevelCommand,
    PoetryVersionCommand,
} from './commands/index';
import { PoetryManager } from './poetryManager';
import { getPoetry } from './poetryUtils';

export class PoetryPackageManager implements PackageManager, Disposable {
    private readonly packagesChangedEmitter = new EventEmitter<DidChangePackagesEventArgs>();
    readonly onDidChangePackages: Event<DidChangePackagesEventArgs> = this.packagesChangedEmitter.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly poetryManager: PoetryManager,
        private readonly project?: PythonProject,
    ) {
        this.name = 'poetry';
        this.displayName = 'Poetry';
        this.description = 'This package manager for Python uses Poetry for package management.';
        this.tooltip = new MarkdownString('This package manager for Python uses `poetry` for package management.');
        this.iconPath = new ThemeIcon('package');
    }
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
    readonly iconPath?: IconPath;

    /**
     * Creates a Poetry package manager bound to a Python project.
     *
     * @param project The project whose working directory Poetry commands should use.
     * @returns A Poetry package manager scoped to the project.
     */
    createForProject(project: PythonProject): PoetryPackageManager {
        return new PoetryPackageManager(
            this.api,
            this.log,
            this.poetryManager,
            project,
        );
    }

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        const cwd = await this.getProjectCwd();
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            if (options.runHeadless) {
                // Headless mode: skip the interactive package input prompt.
                return;
            }
            // Show package input UI if no packages are specified
            const installInput = await showInputBox({
                prompt: 'Enter packages to install (comma separated)',
                placeHolder: 'e.g., requests, pytest, black',
            });

            if (installInput) {
                toInstall = installInput
                    .split(',')
                    .map((p) => p.trim())
                    .filter((p) => p.length > 0);
            }

            if (toInstall.length === 0) {
                return;
            }
        }

        const execute = async (token?: CancellationToken): Promise<void> => {
            try {
                await this.runPoetryManage({ install: toInstall, uninstall: toUninstall }, cwd, token);
                await updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this.packagesChangedEmitter.fire({ environment, manager: this, changes });
                    },
                );
            } catch (e) {
                if (e instanceof CancellationError) {
                    throw e;
                }
                this.log.error('Error managing packages with Poetry', e);
                if (!options.runHeadless) {
                    setImmediate(async () => {
                        const result = await showErrorMessage('Error managing packages with Poetry', 'View Output');
                        if (result === 'View Output') {
                            this.log.show();
                        }
                    });
                }
                throw e;
            }
        };

        if (options.runHeadless) {
            await execute();
            return;
        }

        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Managing packages with Poetry',
                cancellable: true,
            },
            (_progress, token) => execute(token),
        );
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        await this.getProjectCwd();
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing Poetry packages',
            },
            async () => {
                try {
                    const packages = await updatePackagesAndNotify(
                        this,
                        environment,
                        this.packages.get(environment.envId.id),
                        (changes) => {
                            this.packagesChangedEmitter.fire({ environment, manager: this, changes });
                        },
                    );
                    this.packages.set(environment.envId.id, packages ?? []);
                } catch (error) {
                    this.log.error(`Failed to refresh packages: ${error}`);
                    // Show error to user but don't break the UI
                    setImmediate(async () => {
                        const result = await showErrorMessage('Error refreshing Poetry packages', 'View Output');
                        if (result === 'View Output') {
                            this.log.show();
                        }
                    });
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (!this.project) {
            return undefined;
        }
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            const packages = await this.fetchPackagesFromTool(environment);
            this.packages.set(environment.envId.id, packages);
            return packages;
        }
        return this.packages.get(environment.envId.id);
    }

    async getVersion(_environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        const poetry = await getPoetry();
        if (!poetry) {
            return undefined;
        }
        const versionCmd = new PoetryVersionCommand({
            pythonExecutable: poetry,
            log: this.log,
        });
        return await versionCmd.execute();
    }

    async getPackageAvailableVersions(
        _environment: PythonEnvironment,
        _packageName: string,
    ): Promise<Pep440Version[]> {
        throw new PackageVersionLookupNotSupportedError(
            'Poetry does not provide a package version lookup command supported by this extension.',
        );
    }

    formatInstallSpec(packageName: string, version: string): string {
        // Poetry uses `package@version` syntax for version-pinned installs
        return `${packageName}@${version}`;
    }

    dispose(): void {
        this.packagesChangedEmitter.dispose();
        this.packages.clear();
    }

    private async runPoetryManage(
        options: { install?: string[]; uninstall?: string[] },
        cwd: string,
        token?: CancellationToken,
    ): Promise<void> {
        const poetry = await getPoetry();
        if (!poetry) {
            throw new Error(
                l10n.t(
                    'Poetry executable not found. Install Poetry to manage packages, or set the "python.poetryPath" setting.',
                ),
            );
        }
        // Handle uninstalls first
        if (options.uninstall && options.uninstall.length > 0) {
            const removeCmd = new PoetryRemoveCommand({
                pythonExecutable: poetry,
                cwd,
                log: this.log,
            });
            const packages = parsePackageSpecs(options.uninstall);
            await removeCmd.execute({ packages, cancellationToken: token });
        }

        // Handle installs
        if (options.install && options.install.length > 0) {
            const addCmd = new PoetryAddCommand({
                pythonExecutable: poetry,
                cwd,
                log: this.log,
            });
            const packages = parsePackageSpecs(options.install);
            await addCmd.execute({ packages, cancellationToken: token });
        }
    }

    private async fetchPackagesFromTool(environment: PythonEnvironment): Promise<Package[]> {
        const poetry = await getPoetry();
        if (!poetry) {
            throw new Error(
                l10n.t(
                    'Poetry executable not found. Install Poetry to manage packages, or set the "python.poetryPath" setting.',
                ),
            );
        }

        const cwd = await this.getProjectCwd();
        const showCmd = new PoetryShowCommand({
            pythonExecutable: poetry,
            cwd,
            log: this.log,
        });
        try {
            const data = await showCmd.execute();
            return data.map((pkg) => this.api.createPackageItem(pkg, environment, this));
        } catch (error) {
            this.log.error(`Error refreshing packages with Poetry: ${error}`);
            return [];
        }
    }

    async getDirectPackageNames(_environment: PythonEnvironment): Promise<Set<string> | undefined> {
        if (!this.project) {
            return undefined;
        }
        try {
            const poetry = await getPoetry();
            if (!poetry) {
                return undefined;
            }
            const showTopLevelCmd = new PoetryShowTopLevelCommand({
                pythonExecutable: poetry,
                cwd: await this.getProjectCwd(),
                log: this.log,
            });
            return await showTopLevelCmd.execute();
        } catch (err) {
            this.log.error(`Error fetching direct package names with Poetry: ${err}`);
            return undefined;
        }
    }

    private async getProjectCwd(): Promise<string> {
        if (!this.project) {
            throw new Error(l10n.t('Poetry package operations require a Python project.'));
        }
        const toDirectory = async (fsPath: string): Promise<string> => {
            try {
                const stat = await fsapi.stat(fsPath);
                return stat.isDirectory() ? fsPath : path.dirname(fsPath);
            } catch {
                return path.dirname(fsPath);
            }
        };

        return toDirectory(this.project.uri.fsPath);
    }
}
