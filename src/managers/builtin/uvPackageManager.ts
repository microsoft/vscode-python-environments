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
    Capabilities,
    CapabilityCheck,
    DidChangePackagesEventArgs,
    GetPackagesOptions,
    Package,
    PackageCapability,
    PackageManagementOptions,
    PackageManager,
    PackageManagerCapability,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { PythonVersion } from '../../common/pythonVersion';
import { showErrorMessage, withProgress } from '../../common/window.apis';
import { PackageToolSupport, pythonToolSupport, throwIfCancelled } from '../../internal/pythonToolSupport';
import { CommandConstructorOptions } from '../base/commands/index';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { parsePackageSpecs } from '../common/packageUtils';
import {
    UvAvailableVersionsCommand,
    UvInstallCommand,
    UvListCommand,
    UvListDirectNamesCommand,
    UvUninstallCommand,
    UvVersionCommand,
} from './commands/index';
import { getUvExecutable } from './helpers';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { VenvManager } from './venvManager';

/** Manages packages using only uv, without requiring pip in the environment. */
export class UvPackageManager implements PackageManager, Disposable {
    readonly name = 'uv';
    readonly displayName = 'uv';
    readonly description = l10n.t('This package manager for Python installs using uv.');
    readonly tooltip = new MarkdownString(l10n.t('This package manager for Python installs using `uv`.'));
    readonly iconPath = new ThemeIcon('python');

    private readonly packageManagementCapability: CapabilityCheck = async ({ environment }) => {
        if (PythonVersion.tryParse(environment?.version)?.major === 2) {
            return { supported: false, reason: l10n.t('Python 2.* is not supported (deprecated)') };
        }
        return { supported: true };
    };

    readonly capabilities: Capabilities<PackageManagerCapability> = {
        [PackageCapability.List]: this.packageManagementCapability,
        [PackageCapability.Install]: this.packageManagementCapability,
        [PackageCapability.Uninstall]: this.packageManagementCapability,
        [PackageCapability.Upgrade]: this.packageManagementCapability,
        [PackageCapability.FetchAvailableVersions]: this.packageManagementCapability,
        [PackageCapability.ListDirect]: this.packageManagementCapability,
    };

    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    readonly onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;
    private readonly packages = new Map<string, Package[]>();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly venv: VenvManager,
    ) {}

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

    private async getCommandOptions(
        environment: PythonEnvironment,
        options: Omit<CommandConstructorOptions, 'pythonExecutable'> = {},
    ): Promise<CommandConstructorOptions> {
        const support = await this.packageManagementCapability({ environment });
        if (!support.supported) {
            throw new Error(support.reason);
        }
        const token = options.toolExecution ? options.cancellationToken : undefined;
        const uvExecutable = await getUvExecutable(this.log, environment.environmentPath.fsPath, token);
        if (!uvExecutable) {
            throw new Error(l10n.t('uv is unavailable. Install uv or select a different package manager.'));
        }
        // The directory preserves the environment boundary when its interpreter is a symlink.
        return { ...options, pythonExecutable: environment.environmentPath.fsPath, uvExecutable, log: this.log };
    }

    /**
     * Installs, upgrades, or removes packages using uv.
     * Invalidates cached inventory after mutation attempts, including failure or cancellation.
     * @param environment Target Python environment.
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
        let toInstall = [...(options.install ?? [])];
        let toUninstall = [...(options.uninstall ?? [])];
        if (toInstall.length === 0 && toUninstall.length === 0) {
            if (options.runHeadless) {
                return;
            }
            const projects = this.venv.getProjectsByEnvironment(environment);
            const result = await getWorkspacePackagesToInstall(
                this.api, options, projects, environment, this.log,
                async () => new UvListCommand(await this.getCommandOptions(environment)).execute(),
            );
            if (!result) {
                return;
            }
            toInstall = result.install;
            toUninstall = result.uninstall;
        }
        const support = await this.packageManagementCapability({ environment });
        if (!support.supported) {
            throw new Error(support.reason);
        }
        const execute = async (token?: CancellationToken): Promise<void> => {
            const previousPackages = this.packages.get(environment.envId.id);
            try {
                try {
                    const commandOptions = {
                        cwd: scope?.fsPath,
                        cancellationToken: token,
                        toolExecution: !!toolToken,
                    };
                    if (toUninstall.length > 0) {
                        const command = new UvUninstallCommand(await this.getCommandOptions(environment, commandOptions));
                        await command.execute({
                            packages: parsePackageSpecs(toUninstall),
                            cancellationToken: token,
                            toolExecution: !!toolToken,
                        });
                    }
                    if (toInstall.length > 0) {
                        const command = new UvInstallCommand(await this.getCommandOptions(environment, commandOptions));
                        await command.execute({
                            packages: parsePackageSpecs(toInstall),
                            upgrade: options.upgrade,
                            cancellationToken: token,
                            toolExecution: !!toolToken,
                        });
                    }
                } finally {
                    this.packages.delete(environment.envId.id);
                }
                await updatePackagesAndNotify(
                    this,
                    environment,
                    previousPackages,
                    (changes) => this._onDidChangePackages.fire({ environment, manager: this, changes }),
                    () => this.fetchPackages(environment, !options.runHeadless, toolToken),
                    !!toolToken,
                );
            } catch (error) {
                if (error instanceof CancellationError) {
                    throw error;
                }
                this.log.error('Error managing packages', error);
                if (!options.runHeadless) {
                    setImmediate(async () => {
                        const viewOutput = l10n.t('View Output');
                        if (await showErrorMessage(l10n.t('Error managing packages'), viewOutput) === viewOutput) {
                            this.log.show();
                        }
                    });
                }
                throw error;
            }
        };
        if (options.runHeadless) {
            await execute(toolToken);
            return;
        }
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: toInstall.length === 0 && toUninstall.length > 0
                    ? l10n.t('Uninstalling packages')
                    : l10n.t('Installing packages'),
                cancellable: true,
            },
            (_progress, token) => execute(token),
        );
    }

    /** Refreshes cached packages and emits changes for the target environment. */
    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            { location: ProgressLocation.Window, title: l10n.t('Refreshing packages') },
            async () => {
                const packages = await updatePackagesAndNotify(
                    this, environment, this.packages.get(environment.envId.id),
                    (changes) => this._onDidChangePackages.fire({ environment, manager: this, changes }),
                );
                if (packages !== undefined) {
                    this.packages.set(environment.envId.id, packages);
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
        try {
            throwIfCancelled(token);
            const command = new UvListCommand(await this.getCommandOptions(environment, {
                cancellationToken: token, toolExecution: !!token,
            }));
            const data = await command.execute(
                token ? { cancellationToken: token, strict: true, toolExecution: true } : undefined,
            );
            throwIfCancelled(token);
            const packages = data.map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
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

    /** Returns the uv version, logging failures when it cannot be determined. */
    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            return await new UvVersionCommand(await this.getCommandOptions(environment)).execute();
        } catch (error) {
            this.log.error('Error determining uv version', error);
            return undefined;
        }
    }

    /** Lists compatible versions of packageName, newest first, without querying the environment's pip. */
    async getPackageAvailableVersions(environment: PythonEnvironment, packageName: string): Promise<Pep440Version[]> {
        const pythonVersion = environment.version
            ? PythonVersion.tryParse(environment.version)?.toReleaseString()
            : undefined;
        if (!pythonVersion) {
            throw new Error(`Python version is unavailable for environment: ${environment.envId.id}`);
        }
        const command = new UvAvailableVersionsCommand(await this.getCommandOptions(environment));
        const versions = await command.execute({ packageName, pythonVersion });
        return versions.sort((a, b) => compare(b.public, a.public));
    }

    /** Returns dependency-root package names, which need not reflect explicit user install intent. */
    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        return new UvListDirectNamesCommand(await this.getCommandOptions(environment)).execute();
    }

    /** Releases package-change listeners and cached packages. */
    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }
}
