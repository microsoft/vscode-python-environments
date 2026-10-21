import type { Pep440Version } from '@renovatebot/pep440';
import { compare } from '@renovatebot/pep440';
import {
    CancellationError,
    CancellationToken,
    Disposable,
    Event,
    EventEmitter,
    l10n,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
    Uri,
} from 'vscode';
import {
    DidChangePackagesEventArgs,
    GetPackagesOptions,
    IconPath,
    isPackageVersionLookupNotSupportedError,
    Package,
    PackageManagementOptions,
    PackageManager,
    PackageVersionLookupNotSupportedError,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import {
    Capabilities,
    CapabilityCheck,
    PackageCapability,
    PackageManagerCapability,
    supportedCapability,
} from '../../capabilities';
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { PythonVersion } from '../../common/pythonVersion';
import { showErrorMessage, withProgress } from '../../common/window.apis';
import { PackageToolSupport, pythonToolSupport, throwIfCancelled } from '../../internal/pythonToolSupport';
import { AvailableVersionsCommand } from '../base/commands/index';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { parsePackageSpecs } from '../common/packageUtils';
import {
    PipAvailableVersionsCommand,
    PipAvailableVersionsTextCommand,
    PipInstallCommand,
    PipListCommand,
    PipListDirectNamesCommand,
    PipUninstallCommand,
    PipVersionCommand,
} from './commands/index';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { VenvManager } from './venvManager';

/** Manages packages using only the selected environment's pip installation. */
export class PipPackageManager implements PackageManager, Disposable {
    private readonly packageManagementCapability: CapabilityCheck = async ({ environment }) => {
        if (PythonVersion.tryParse(environment?.version)?.major === 2) {
            return { supported: false, reason: l10n.t('Python 2.* is not supported (deprecated)') };
        }
        return { supported: true };
    };

    readonly capabilities: Capabilities<PackageManagerCapability> = {
        [PackageCapability.List]: supportedCapability,
        [PackageCapability.Install]: this.packageManagementCapability,
        [PackageCapability.Uninstall]: this.packageManagementCapability,
        [PackageCapability.Upgrade]: this.packageManagementCapability,
        [PackageCapability.FetchAvailableVersions]: async ({ environment }) => {
            if (!environment) {
                return {
                    supported: false,
                    reason: l10n.t('An environment is required to check package version lookup support.'),
                };
            }
            try {
                await this.getPackageAvailableVersionsCommand(environment);
            } catch (error) {
                if (isPackageVersionLookupNotSupportedError(error)) {
                    return { supported: false, reason: error.message };
                }
                throw error;
            }
            return await supportedCapability({ environment });
        },
        // Dependency roots are best-effort classification, not exact user install intent.
        [PackageCapability.ListDirect]: supportedCapability,
    };

    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;
    private readonly _onDidMutatePackages = new EventEmitter<{ environment: PythonEnvironment; packages?: Package[] }>();
    readonly onDidMutatePackages = this._onDidMutatePackages.event;

    private packages: Map<string, Package[]> = new Map();
    private readonly baselinePackages = new Map<string, Package[]>();
    private readonly cacheVersions = new Map<string, symbol>();
    private packageManagerOwner: PackageManager = this;

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly venv: VenvManager,
    ) {}
    readonly name = 'pip';
    readonly displayName = 'Pip';
    readonly description = l10n.t('This package manager for python installs using pip.');
    readonly tooltip = new MarkdownString(l10n.t('This package manager for python installs using `pip`.'));
    readonly iconPath: IconPath = new ThemeIcon('python');

    /** Sets the registered identity used for package items and events when this manager is wrapped. */
    setPackageManagerOwner(owner: PackageManager): void {
        this.packageManagerOwner = owner;
    }

    /** Evicts inventory for an environment without emitting public package changes. */
    invalidateCache(environment: PythonEnvironment, baseline?: Package[]): void {
        const id = environment.envId.id;
        this.packages.delete(id);
        this.cacheVersions.delete(id);
        if (baseline !== undefined) {
            this.baselinePackages.set(id, baseline);
        } else {
            this.baselinePackages.delete(id);
        }
    }

    private getBaselinePackages(environment: PythonEnvironment): Package[] | undefined {
        const id = environment.envId.id;
        return this.packages.get(id) ?? this.baselinePackages.get(id);
    }

    private getCacheVersion(environment: PythonEnvironment): symbol {
        const version = this.cacheVersions.get(environment.envId.id) ?? Symbol();
        this.cacheVersions.set(environment.envId.id, version);
        return version;
    }

    private cachePackages(environment: PythonEnvironment, packages: Package[], cacheVersion: symbol): void {
        const id = environment.envId.id;
        if (this.cacheVersions.get(id) === cacheVersion) {
            this.packages.set(id, packages);
            this.baselinePackages.set(id, packages);
            this._onDidMutatePackages.fire({ environment, packages });
        }
    }

    readonly [pythonToolSupport]: PackageToolSupport = {
        manage: (environment, options, token, scope) =>
            this.manage(environment, { ...options, runHeadless: true }, token, scope),
        getPackages: async (environment, token) => {
            const packages = await this.fetchPackages(environment, false, token);
            if (!packages) {
                throw new Error('Package listing returned no result.');
            }
            return packages;
        },
    };

    /**
     * Installs, upgrades, or uninstalls packages in the target environment.
     * Invalidates cached inventory after mutation attempts, including failure or cancellation.
     * @param environment Environment whose packages should change.
     * @param options Requested operations and whether to suppress interactive UI.
     * @param toolToken Cancellation token for a headless tool request.
     * @param scope Working directory for tool execution.
     */
    async manage(
        environment: PythonEnvironment,
        options: PackageManagementOptions,
        toolToken?: CancellationToken,
        scope?: Uri,
    ): Promise<void> {
        throwIfCancelled(toolToken);
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            if (options.runHeadless) {
                return;
            }
            const projects = this.venv.getProjectsByEnvironment(environment);
            const result = await getWorkspacePackagesToInstall(
                this.api, options, projects, environment, this.log,
                async () => new PipListCommand({
                    pythonExecutable: environment.execInfo.run.executable, log: this.log,
                }).execute(),
            );
            if (result) {
                toInstall = result.install;
                toUninstall = result.uninstall;
            } else {
                return;
            }
        }

        const support = await this.packageManagementCapability({ environment });
        if (!support.supported) {
            throw new Error(support.reason);
        }

        const execute = async (token?: CancellationToken): Promise<void> => {
            const previousPackages = this.getBaselinePackages(environment);
            try {
                try {
                    if (!environment.execInfo?.run?.executable) {
                        throw new Error('Unable to determine Python executable path');
                    }
                    const manageCommandOptions = {
                        pythonExecutable: environment.execInfo.run.executable,
                        log: this.log,
                        cwd: scope?.fsPath,
                        cancellationToken: token,
                        toolExecution: !!toolToken,
                    };

                    if (toUninstall.length > 0) {
                        const command = new PipUninstallCommand(manageCommandOptions);
                        await command.execute({
                            packages: parsePackageSpecs(toUninstall),
                            cancellationToken: token,
                            toolExecution: !!toolToken,
                        });
                    }

                    if (toInstall.length > 0) {
                        const command = new PipInstallCommand(manageCommandOptions);
                        await command.execute({
                            packages: parsePackageSpecs(toInstall),
                            upgrade: options.upgrade,
                            cancellationToken: token,
                            toolExecution: !!toolToken,
                        });
                    }
                } finally {
                    this.invalidateCache(environment);
                    this._onDidMutatePackages.fire({ environment });
                }

                await updatePackagesAndNotify(
                    this,
                    environment,
                    previousPackages,
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this.packageManagerOwner, changes });
                    },
                    () => this.fetchPackages(environment, !options.runHeadless, toolToken),
                    !!toolToken,
                );
            } catch (e) {
                if (e instanceof CancellationError) {
                    throw e;
                }
                this.log.error('Error managing packages', e);
                if (!options.runHeadless) {
                    setImmediate(async () => {
                        const viewOutput = l10n.t('View Output');
                        const result = await showErrorMessage(l10n.t('Error managing packages'), viewOutput);
                        if (result === viewOutput) {
                            this.log.show();
                        }
                    });
                }
                throw e;
            }
        };

        if (options.runHeadless) {
            await execute(toolToken);
            return;
        }

        const title =
            toInstall.length === 0 && toUninstall.length > 0
                ? l10n.t('Uninstalling packages')
                : l10n.t('Installing packages');
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            (_progress, token) => execute(token),
        );
    }

    /** Refreshes the environment's package cache and emits package changes. */
    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: l10n.t('Refreshing packages'),
            },
            async () => {
                const cacheVersion = this.getCacheVersion(environment);
                const packages = await updatePackagesAndNotify(
                    this,
                    environment,
                    this.getBaselinePackages(environment),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this.packageManagerOwner, changes });
                    },
                );
                if (packages !== undefined) {
                    this.cachePackages(environment, packages, cacheVersion);
                }
            },
        );
    }

    /** Lists installed packages, using the cache unless options request a fresh snapshot. */
    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            return this.fetchPackages(environment);
        }
        return this.packages.get(environment.envId.id);
    }

    private async fetchPackages(
        environment: PythonEnvironment,
        showErrors = true,
        token?: CancellationToken,
    ): Promise<Package[] | undefined> {
        const cacheVersion = this.getCacheVersion(environment);
        try {
            throwIfCancelled(token);
            if (!environment.execInfo?.run?.executable) {
                throw new Error('Unable to determine Python executable path');
            }
            const listCmd = new PipListCommand({
                pythonExecutable: environment.execInfo.run.executable,
                log: this.log,
                cancellationToken: token,
                toolExecution: !!token,
            });
            const data = await listCmd.execute(
                token ? { cancellationToken: token, strict: true, toolExecution: true } : undefined,
            );
            throwIfCancelled(token);
            const packages = data.map((pkg) => this.api.createPackageItem(pkg, environment, this.packageManagerOwner));
            this.cachePackages(environment, packages, cacheVersion);
            return packages;
        } catch (error) {
            this.log.error('Error refreshing packages', error);
            if (token) {
                throw error;
            }
            if (showErrors) {
                setImmediate(async () => {
                    await showErrorMessageWithLogs(l10n.t('Error refreshing packages'), this.log);
                });
            }
            return this.packages.get(environment.envId.id);
        }
    }

    /** Returns the underlying tool's version, logging failures when it cannot be determined. */
    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            if (!environment.execInfo?.run?.executable) {
                return undefined;
            }
            const versionCmd = new PipVersionCommand({
                pythonExecutable: environment.execInfo.run.executable, log: this.log,
            });
            return await versionCmd.execute();
        } catch (error) {
            this.log.error(`Error determining ${this.name} version`, error);
            return undefined;
        }
    }

    private async getPackageAvailableVersionsCommand(
        environment: PythonEnvironment,
    ): Promise<AvailableVersionsCommand> {
        const pythonExecutable = environment.execInfo?.run?.executable;
        if (!pythonExecutable) {
            throw new Error(`Python executable is unavailable for environment: ${environment.envId.id}`);
        }
        const options = { pythonExecutable, log: this.log };
        const version = await new PipVersionCommand(options).execute();
        if (!version) {
            throw new Error(`Unable to determine pip version for environment: ${environment.envId.id}`);
        }
        if (compare(version.public, '21.2.0') < 0) {
            throw new PackageVersionLookupNotSupportedError(
                l10n.t('Package version lookup requires pip 21.2 or newer; the environment has pip {0}.', version.public),
            );
        }
        return compare(version.public, '25.1') >= 0
            ? new PipAvailableVersionsCommand(options)
            : new PipAvailableVersionsTextCommand(options);
    }

    /** Lists versions of packageName compatible with the environment, newest first. */
    async getPackageAvailableVersions(environment: PythonEnvironment, packageName: string): Promise<Pep440Version[]> {
        const baseVersion = environment.version
            ? PythonVersion.tryParse(environment.version)?.toReleaseString()
            : undefined;
        if (!baseVersion) {
            throw new Error(`Python version is unavailable for environment: ${environment.envId.id}`);
        }
        const command = await this.getPackageAvailableVersionsCommand(environment);
        const versions = await command.execute({ packageName, pythonVersion: baseVersion });
        return versions.sort((a, b) => compare(b.public, a.public));
    }

    /** Releases package-change listeners and cached packages. */
    dispose(): void {
        this._onDidChangePackages.dispose();
        this._onDidMutatePackages.dispose();
        this.packages.clear();
        this.baselinePackages.clear();
        this.cacheVersions.clear();
    }

    /**
     * Returns direct (non-transitive) package names.
     *
     * pip uses `pip list --format=json --not-required`; uv uses `uv pip tree --depth=0`.
     *
     * Note: These return top-level packages (no installed dependents / roots of the
     * dependency tree), not necessarily packages the user explicitly installed. pip/uv
     * do not track install intent.
     */
    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        const pythonExecutable = environment.execInfo?.run?.executable;
        if (!pythonExecutable) {
            return undefined;
        }
        const listDirectNamesCmd = new PipListDirectNamesCommand({ pythonExecutable, log: this.log });
        return listDirectNamesCmd.execute();
    }
}
