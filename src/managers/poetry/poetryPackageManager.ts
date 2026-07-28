import type { Pep440Version } from '@renovatebot/pep440';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import {
    CancellationError,
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
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { showErrorMessage, showInputBox, withProgress } from '../../common/window.apis';
import { parsePackageSpecs } from '../builtin/utils';
import { updatePackagesAndNotify } from '../common/packageChanges';
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
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        _poetry: PoetryManager,
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

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
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

        try {
            await this.runPoetryManage({ install: toInstall, uninstall: toUninstall });
            await updatePackagesAndNotify(this, environment, this.packages.get(environment.envId.id), (changes) => {
                this._onDidChangePackages.fire({ environment, manager: this, changes });
            });
        } catch (e) {
            if (e instanceof CancellationError) {
                // Cancellation is not an error; rethrow without surfacing an error message.
                throw e;
            }
            this.log.error('Error managing packages with Poetry', e);
            setImmediate(async () => {
                const result = await showErrorMessage('Error managing packages with Poetry', 'View Output');
                if (result === 'View Output') {
                    this.log.show();
                }
            });
            throw e;
        }
    }

    async refresh(environment: PythonEnvironment): Promise<Package[] | undefined> {
        return withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing Poetry packages',
            },
            async () => {
                try {
                    return await updatePackagesAndNotify(
                        this,
                        environment,
                        this.packages.get(environment.envId.id),
                        (changes) => {
                            this._onDidChangePackages.fire({ environment, manager: this, changes });
                        },
                    );
                } catch (error) {
                    this.log.error(`Failed to refresh packages: ${error}`);
                    // Show error to user but don't break the UI
                    setImmediate(async () => {
                        const result = await showErrorMessage('Error refreshing Poetry packages', 'View Output');
                        if (result === 'View Output') {
                            this.log.show();
                        }
                    });
                    return undefined;
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
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
    ): Promise<Pep440Version[] | undefined> {
        // Poetry doesn't have a native "list available versions" command.
        // Poetry 2.x supports `poetry search` but it was disabled on PyPI.
        // Return undefined to indicate this manager doesn't support version listing.
        return undefined;
    }

    formatInstallSpec(packageName: string, version: string): string {
        // Poetry uses `package@version` syntax for version-pinned installs
        return `${packageName}@${version}`;
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }

    private async runPoetryManage(options: { install?: string[]; uninstall?: string[] }): Promise<void> {
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
                log: this.log,
            });
            const packages = parsePackageSpecs(options.uninstall);
            await withProgress(
                { location: ProgressLocation.Notification, title: 'Managing packages with Poetry', cancellable: true },
                (_progress, token) => removeCmd.execute({ packages, cancellationToken: token }),
            );
        }

        // Handle installs
        if (options.install && options.install.length > 0) {
            const addCmd = new PoetryAddCommand({
                pythonExecutable: poetry,
                log: this.log,
            });
            const packages = parsePackageSpecs(options.install);
            await withProgress(
                { location: ProgressLocation.Notification, title: 'Managing packages with Poetry', cancellable: true },
                (_progress, token) => addCmd.execute({ packages, cancellationToken: token }),
            );
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

        const showCmd = new PoetryShowCommand({
            pythonExecutable: poetry,
            log: this.log,
        });
        const cwd = await this.getPoetryCwd();
        const data = await showCmd.execute({ cwd });
        return (data ?? []).map((pkg) => this.api.createPackageItem(pkg, environment, this));
    }

    async getDirectPackageNames(_environment: PythonEnvironment): Promise<Set<string> | undefined> {
        try {
            const poetry = await getPoetry();
            if (!poetry) {
                return undefined;
            }
            const showTopLevelCmd = new PoetryShowTopLevelCommand({
                pythonExecutable: poetry,
                log: this.log,
            });
            return await showTopLevelCmd.execute();
        } catch (err) {
            this.log.error(`Error fetching direct package names with Poetry: ${err}`);
            return undefined;
        }
    }

    private async getPoetryCwd(): Promise<string | undefined> {
        const projects = this.api.getPythonProjects();
        if (projects.length !== 1) {
            return undefined;
        }

        const toDirectory = async (fsPath: string): Promise<string> => {
            try {
                const stat = await fsapi.stat(fsPath);
                return stat.isDirectory() ? fsPath : path.dirname(fsPath);
            } catch {
                return path.dirname(fsPath);
            }
        };

        return toDirectory(projects[0].uri.fsPath);
    }
}
