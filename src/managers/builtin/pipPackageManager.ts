import type { Pep440Version } from '@renovatebot/pep440';
import { compare, explain as parse } from '@renovatebot/pep440';
import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    l10n,
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
import { withProgress } from '../../common/window.apis';
import { CommandConstructorOptions } from '../base/commands/index';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { createPipOrUvCommand } from './commands/factory';
import {
    PipAvailableVersionsCommand,
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
import { parsePackageSpecs } from './utils';
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

        if (environment.version.startsWith('2.')) {
            throw new Error('Python 2.* is not supported (deprecated)');
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
                const uninstallCmd: PipUninstallCommand | UvUninstallCommand = await createPipOrUvCommand(
                    manageCommandOptions,
                    environment.environmentPath.fsPath,
                    PipUninstallCommand,
                    UvUninstallCommand,
                );
                const packages = parsePackageSpecs(toUninstall);
                await withProgress(
                    {
                        location: ProgressLocation.Notification,
                        title: l10n.t('Uninstalling packages'),
                        cancellable: true,
                    },
                    (_progress, token) => uninstallCmd.execute({ packages, cancellationToken: token }),
                );
            }

            // Execute install if needed
            if (toInstall.length > 0) {
                const installCmd: PipInstallCommand | UvInstallCommand = await createPipOrUvCommand(
                    manageCommandOptions,
                    environment.environmentPath.fsPath,
                    PipInstallCommand,
                    UvInstallCommand,
                );
                const packages = parsePackageSpecs(toInstall);
                await withProgress(
                    { location: ProgressLocation.Notification, title: 'Installing packages', cancellable: true },
                    (_progress, token) =>
                        installCmd.execute({ packages, upgrade: options.upgrade, cancellationToken: token }),
                );
            }

            await updatePackagesAndNotify(this, environment, this.packages.get(environment.envId.id), (changes) => {
                this._onDidChangePackages.fire({ environment, manager: this, changes });
            });
        } catch (e) {
            if (e instanceof CancellationError) {
                // Cancellation is a normal control-flow exit; skip the user-facing error
                // UI/logging, but rethrow so callers can distinguish cancel from failure
                // (e.g. venv creation sets pkgInstallationCancelled by catching CancellationError).
                throw e;
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

    async refresh(environment: PythonEnvironment): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing packages',
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
                this.packages.set(environment.envId.id, packages ?? []);
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                return undefined;
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
    ): Promise<Pep440Version[] | undefined> {
        try {
            const pythonExecutable = environment.execInfo?.run?.executable;
            if (!pythonExecutable) {
                return undefined;
            }

            // Normalize versions like '3.13.1.final.0' (Python's sys.version_info format) to '3.13.1'
            // before parsing, since pep440 only accepts valid PEP 440 version strings.
            const versionMatch = (environment.version ?? '').match(/^(\d+(?:\.\d+)*)/);
            const normalizedVersion = versionMatch?.[1] ?? '';
            const baseVersion = parse(normalizedVersion)?.base_version;
            if (!baseVersion) {
                return undefined;
            }

            const availableVersionsCmd: PipAvailableVersionsCommand | UvAvailableVersionsCommand =
                await createPipOrUvCommand(
                    { pythonExecutable, log: this.log },
                    environment.environmentPath.fsPath,
                    PipAvailableVersionsCommand,
                    UvAvailableVersionsCommand,
                );

            // For pip < 21.2.0, check version first
            if (availableVersionsCmd instanceof PipAvailableVersionsCommand) {
                const pipVersion = await this.getVersion(environment);
                if (!pipVersion || compare(pipVersion.public, '21.2.0') < 0) {
                    // pip <= 20.3.4 - version picking is undefined; no reliable machine-readable API exists.
                    return undefined;
                }
            }

            const versions = await availableVersionsCmd.execute({
                packageName,
                pythonVersion: baseVersion,
            });
            return versions.sort((a, b) => compare(b.public, a.public));
        } catch {
            return undefined;
        }
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
