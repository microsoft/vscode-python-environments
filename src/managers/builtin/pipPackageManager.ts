import type { Pep440Version } from '@renovatebot/pep440';
import { compare, explain as parse } from '@renovatebot/pep440';
import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
    window,
} from 'vscode';
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
import { CommandConstructorOptions } from '../base/commands/index';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { BuiltinAvailableVersionsCommandFactory } from './commands/availableVersions';
import { PipAvailableVersionsCommand } from './commands/index';
import { BuiltinInstallCommandFactory } from './commands/install';
import { BuiltinListCommandFactory } from './commands/list';
import { BuiltinListDirectNamesCommandFactory } from './commands/listDirectNames';
import { BuiltinUninstallCommandFactory } from './commands/uninstall';
import { BuiltinVersionCommandFactory } from './commands/version';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { normalizePackageName, parsePackageSpecs } from './utils';
import { VenvManager } from './venvManager';

export class PipPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly venv: VenvManager,
    ) {
        this.name = 'pip';
        this.displayName = 'Pip';
        this.description = 'This package manager for python installs using pip.';
        this.tooltip = new MarkdownString('This package manager for python installs using `pip`.');
        this.iconPath = new ThemeIcon('python');
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
            const projects = this.venv.getProjectsByEnvironment(environment);
            const result = await getWorkspacePackagesToInstall(this.api, options, projects, environment, this.log);
            if (result) {
                toInstall = result.install;
                toUninstall = result.uninstall;
            } else {
                return;
            }
        }

        try {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                throw new Error('Unable to determine Python executable path');
            }

            // Centralize command options for install/uninstall operations
            const manageCommandOptions: CommandConstructorOptions = {
                pythonExecutable,
                log: this.log,
            };

            // Execute uninstall if needed
            if (toUninstall.length > 0) {
                const uninstallCmd = await BuiltinUninstallCommandFactory(manageCommandOptions);
                const packages = parsePackageSpecs(toUninstall);
                await uninstallCmd.executeWithProgress({ packages, showProgress: true }, 'Installing packages');
            }

            // Execute install if needed
            if (toInstall.length > 0) {
                const installCmd = await BuiltinInstallCommandFactory(manageCommandOptions);
                const packages = parsePackageSpecs(toInstall);
                await installCmd.executeWithProgress(
                    { packages, upgrade: options.upgrade, showProgress: true },
                    'Installing packages',
                );
            }

            await updatePackagesAndNotify(this, environment, this.packages.get(environment.envId.id), (changes) => {
                this._onDidChangePackages.fire({ environment, manager: this, changes });
            });
        } catch (e) {
            if (e instanceof CancellationError) {
                // Cancellation is a normal control-flow exit; do not surface an error.
                return;
            }
            this.log.error('Error managing packages', e);
            setImmediate(async () => {
                const result = await window.showErrorMessage('Error managing packages', 'View Output');
                if (result === 'View Output') {
                    this.log.show();
                }
            });
            throw e;
        }
    }

    async refresh(environment: PythonEnvironment): Promise<Package[] | undefined> {
        return window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing packages',
            },
            async () => {
                return updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    },
                );
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                return undefined;
            }
            const listCmd = await BuiltinListCommandFactory({
                pythonExecutable,
                log: this.log,
            });
            const data = await listCmd.execute();
            const packages = (data ?? []).map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
            return packages;
        }
        return this.packages.get(environment.envId.id);
    }

    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                return undefined;
            }
            const versionCmd = await BuiltinVersionCommandFactory({
                pythonExecutable,
                log: this.log,
            });
            return await versionCmd.execute();
        } catch {
            return undefined;
        }
    }

    async getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[] | undefined> {
        try {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                return undefined;
            }

            const baseVersion = parse(environment.version)?.base_version;
            if (!baseVersion) {
                return undefined;
            }

            const availableVersionsCmd = await BuiltinAvailableVersionsCommandFactory({
                pythonExecutable,
                log: this.log,
            });

            // For pip < 21.2.0, check version first
            if (availableVersionsCmd instanceof PipAvailableVersionsCommand) {
                const pipVersion = await this.getVersion(environment);
                if (!pipVersion || compare(pipVersion.public, '21.2.0') < 0) {
                    // pip <= 20.3.4 - version picking is undefined; no reliable machine-readable API exists.
                    return undefined;
                }
            }

            const versionStrings = await availableVersionsCmd.execute({
                packageName,
                pythonVersion: environment.version,
            });
            return versionStrings
                .map((v) => parse(v))
                .filter((parsed): parsed is Pep440Version => parsed !== null)
                .sort((a, b) => compare(b.public, a.public));
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }

    /**
     * Returns direct (non-transitive) package names using `pip list --not-required` or `uv pip list --not-required`.
     *
     * Note: These commands return packages with no installed dependents (leaf packages), not packages
     * the user explicitly installed. pip/uv do not track install intent.
     */
    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        const pythonExecutable = environment.execInfo?.run?.executable;
        if (!pythonExecutable) {
            return undefined;
        }
        const listDirectNamesCmd = await BuiltinListDirectNamesCommandFactory({
            pythonExecutable,
            log: this.log,
        });
        const data = await listDirectNamesCmd.execute();
        return data ? new Set(data.map(normalizePackageName)) : undefined;
    }
}
