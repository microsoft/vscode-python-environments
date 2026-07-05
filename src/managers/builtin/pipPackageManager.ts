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
import { updatePackagesAndNotify } from '../common/packageChanges';
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
import { shouldUseUv } from './helpers';
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

        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const pythonExecutable = environment.execInfo?.run?.executable;
                    if (!pythonExecutable) {
                        throw new Error('Unable to determine Python executable path');
                    }

                    // Detect whether to use UV
                    const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);

                    // Execute uninstall if needed
                    if (toUninstall.length > 0) {
                        const UninstallCommand = useUv ? UvUninstallCommand : PipUninstallCommand;
                        const uninstallCmd = new UninstallCommand({
                            pythonExecutable,
                            log: this.log,
                            cancellationToken: token,
                        });
                        const packages = parsePackageSpecs(toUninstall);
                        await uninstallCmd.execute({ packages });
                    }

                    // Execute install if needed
                    if (toInstall.length > 0) {
                        const InstallCommand = useUv ? UvInstallCommand : PipInstallCommand;
                        const installCmd = new InstallCommand({
                            pythonExecutable,
                            log: this.log,
                            cancellationToken: token,
                        });
                        const packages = parsePackageSpecs(toInstall);
                        await installCmd.execute({ packages, upgrade: options.upgrade });
                    }

                    await updatePackagesAndNotify(
                        this,
                        environment,
                        this.packages.get(environment.envId.id),
                        (changes) => {
                            this._onDidChangePackages.fire({ environment, manager: this, changes });
                        },
                    );
                } catch (e) {
                    if (e instanceof CancellationError) {
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
            },
        );
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

            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            const ListCmd = useUv ? UvListCommand : PipListCommand;
            const listCmd = new ListCmd({
                pythonExecutable,
                log: this.log,
                cancellationToken: undefined,
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

            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            const VersionCmd = useUv ? UvVersionCommand : PipVersionCommand;
            const versionCmd = new VersionCmd({
                pythonExecutable,
                log: this.log,
                cancellationToken: undefined,
            });
            const versionString = await versionCmd.execute();
            return versionString ? (parse(versionString) ?? undefined) : undefined;
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

            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            const AvailableVersionsCmd = useUv ? UvAvailableVersionsCommand : PipAvailableVersionsCommand;
            const availableVersionsCmd = new AvailableVersionsCmd({
                pythonExecutable,
                log: this.log,
                cancellationToken: undefined,
            });

            // For pip < 21.2.0, check version first
            if (!useUv) {
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
            return versionStrings.map((v) => parse(v)).filter((parsed) => parsed !== undefined) as Pep440Version[];
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

        const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
        const ListDirectNamesCmd = useUv ? UvListDirectNamesCommand : PipListDirectNamesCommand;
        const listDirectNamesCmd = new ListDirectNamesCmd({
            pythonExecutable,
            log: this.log,
            cancellationToken: undefined,
        });
        const data = await listDirectNamesCmd.execute();
        return data ? new Set(data.map(normalizePackageName)) : undefined;
    }
}
