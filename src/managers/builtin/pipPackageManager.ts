import type { Pep440Version } from '@renovatebot/pep440';
import { compare, explain as parse } from '@renovatebot/pep440';
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
} from 'vscode';
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
} from '../../api';
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { showErrorMessage, withProgress } from '../../common/window.apis';
import { CommandConstructorOptions } from '../base/commands/index';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { parsePackageSpecs } from '../common/packageUtils';
import { createPipOrUvCommand } from './commands/factory';
import {
    PipAvailableVersionsCommand,
    PipAvailableVersionsTextCommand,
    PipInstallCommand,
    PipListCommand,
    PipListDirectNamesCommand,
    PipUninstallCommand,
    PipVersionCommand,
    UvAvailableVersionsCommand,
    UvInstallCommand,
    UvListCommand,
    UvListDirectNamesCommand,
    UvUninstallCommand,
    UvVersionCommand,
} from './commands/index';
import { getWorkspacePackagesToInstall } from './pipUtils';
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
            if (options.runHeadless) {
                return;
            }
            const projects = this.venv.getProjectsByEnvironment(environment);
            const result = await getWorkspacePackagesToInstall(this.api, options, projects, environment, this.log);
            if (result) {
                toInstall = result.install;
                toUninstall = result.uninstall;
            } else {
                return;
            }
        }

        if (environment.version.startsWith('2.')) {
            throw new Error('Python 2.* is not supported (deprecated)');
        }

        const execute = async (token?: CancellationToken): Promise<void> => {
            try {
                const pythonExecutable = environment.execInfo?.run?.executable;
                if (!pythonExecutable) {
                    throw new Error('Unable to determine Python executable path');
                }
                const manageCommandOptions: CommandConstructorOptions = {
                    pythonExecutable,
                    log: this.log,
                };

                if (toUninstall.length > 0) {
                    const command: PipUninstallCommand | UvUninstallCommand = await createPipOrUvCommand(
                        manageCommandOptions,
                        environment.environmentPath.fsPath,
                        PipUninstallCommand,
                        UvUninstallCommand,
                    );
                    await command.execute({
                        packages: parsePackageSpecs(toUninstall),
                        cancellationToken: token,
                    });
                }

                if (toInstall.length > 0) {
                    const command: PipInstallCommand | UvInstallCommand = await createPipOrUvCommand(
                        manageCommandOptions,
                        environment.environmentPath.fsPath,
                        PipInstallCommand,
                        UvInstallCommand,
                    );
                    await command.execute({
                        packages: parsePackageSpecs(toInstall),
                        upgrade: options.upgrade,
                        cancellationToken: token,
                    });
                }

                await updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    },
                    () => this.fetchPackages(environment, !options.runHeadless),
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
            await execute();
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

    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: l10n.t('Refreshing packages'),
            },
            async () => {
                const packages = await updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    },
                );
                if (packages !== undefined) {
                    this.packages.set(environment.envId.id, packages);
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            return this.fetchPackages(environment);
        }
        return this.packages.get(environment.envId.id);
    }

    private async fetchPackages(environment: PythonEnvironment, showErrors = true): Promise<Package[] | undefined> {
        try {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                throw new Error('Unable to determine Python executable path');
            }
            const listCmd: PipListCommand | UvListCommand = await createPipOrUvCommand(
                {
                    pythonExecutable,
                    log: this.log,
                },
                environment.environmentPath.fsPath,
                PipListCommand,
                UvListCommand,
            );
            const data = await listCmd.execute();
            const packages = data.map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
            return packages;
        } catch (error) {
            this.log.error('Error refreshing packages', error);
            if (showErrors) {
                setImmediate(async () => {
                    await showErrorMessageWithLogs(l10n.t('Error refreshing packages'), this.log);
                });
            }
            return this.packages.get(environment.envId.id);
        }
    }

    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                return undefined;
            }
            const versionCmd: PipVersionCommand | UvVersionCommand = await createPipOrUvCommand(
                { pythonExecutable, log: this.log },
                environment.environmentPath.fsPath,
                PipVersionCommand,
                UvVersionCommand,
            );
            return await versionCmd.execute();
        } catch {
            return undefined;
        }
    }

    async getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[]> {
        const pythonExecutable = environment.execInfo?.run?.executable;
        if (!pythonExecutable) {
            throw new Error(`Python executable is unavailable for environment: ${environment.envId.id}`);
        }

        // Normalize versions like '3.13.1.final.0' (Python's sys.version_info format) to '3.13.1'
        // before parsing, since pep440 only accepts valid PEP 440 version strings.
        const versionMatch = (environment.version ?? '').match(/^(\d+(?:\.\d+)*)/);
        const normalizedVersion = versionMatch?.[1] ?? '';
        const baseVersion = parse(normalizedVersion)?.base_version;
        if (!baseVersion) {
            throw new Error(`Python version is unavailable for environment: ${environment.envId.id}`);
        }

        const availableVersionsCmd: PipAvailableVersionsCommand | UvAvailableVersionsCommand =
            await createPipOrUvCommand(
                { pythonExecutable, log: this.log },
                environment.environmentPath.fsPath,
                PipAvailableVersionsCommand,
                UvAvailableVersionsCommand,
            );

        // For pip < 21.2.0, check version first.
        if (availableVersionsCmd instanceof PipAvailableVersionsCommand) {
            const pipVersion = await new PipVersionCommand({ pythonExecutable, log: this.log }).execute();
            if (!pipVersion) {
                throw new Error(`Unable to determine pip version for environment: ${environment.envId.id}`);
            }
            if (compare(pipVersion.public, '21.2.0') < 0) {
                throw new PackageVersionLookupNotSupportedError(
                    `Package version lookup requires pip 21.2 or newer; the environment has pip ${pipVersion.public}.`,
                );
            }
            if (compare(pipVersion.public, '25.1') >= 0) {
                const versions = await availableVersionsCmd.execute({
                    packageName,
                    pythonVersion: baseVersion,
                });
                return versions.sort((a, b) => compare(b.public, a.public));
            }

            const textCommand = new PipAvailableVersionsTextCommand({ pythonExecutable, log: this.log });
            const textVersions = await textCommand.execute({ packageName, pythonVersion: baseVersion });
            return textVersions.sort((a, b) => compare(b.public, a.public));
        }

        const versions = await availableVersionsCmd.execute({
            packageName,
            pythonVersion: baseVersion,
        });
        return versions.sort((a, b) => compare(b.public, a.public));
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
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
        const listDirectNamesCmd: PipListDirectNamesCommand | UvListDirectNamesCommand = await createPipOrUvCommand(
            { pythonExecutable, log: this.log },
            environment.environmentPath.fsPath,
            PipListDirectNamesCommand,
            UvListDirectNamesCommand,
        );
        return listDirectNamesCmd.execute();
    }
}
