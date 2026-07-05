import type { Pep440Version } from '@renovatebot/pep440';
import { explain as parse } from '@renovatebot/pep440';
import * as path from 'path';
import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    RelativePattern,
} from 'vscode';
import {
    CommandConstructorOptions,
    DidChangePackagesEventArgs,
    GetPackagesOptions,
    IconPath,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { CondaStrings } from '../../common/localize';
import { withProgress } from '../../common/window.apis';
import { parsePackageSpecs } from '../builtin/utils';
import { updatePackagesAndNotify } from '../common/packageChanges';
import {
    CondaAvailableVersionsCommand,
    CondaInstallCommand,
    CondaListCommand,
    CondaUninstallCommand,
    CondaVersionCommand,
} from './commands/index';
import { getCommonCondaPackagesToInstall } from './condaUtils';

export class CondaPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        public readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
    ) {
        this.name = 'conda';
        this.displayName = 'Conda';
        this.description = CondaStrings.condaPackageMgr;
        this.tooltip = CondaStrings.condaPackageMgr;
    }
    name: string;
    displayName?: string;
    description?: string;
    tooltip?: string | MarkdownString;
    iconPath?: IconPath;

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            const result = await getCommonCondaPackagesToInstall(environment, options, this.api);
            if (result) {
                toInstall = result.install;
                toUninstall = result.uninstall;
            } else {
                return;
            }
        }

        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: CondaStrings.condaInstallingPackages,
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    // Centralize command options for install/uninstall operations
                    const manageCommandOptions: CommandConstructorOptions = {
                        pythonExecutable: 'conda',
                        log: this.log,
                    };

                    // Execute uninstall if needed
                    if (toUninstall.length > 0) {
                        const uninstallCmd = new CondaUninstallCommand(manageCommandOptions);
                        const packages = parsePackageSpecs(toUninstall);
                        await uninstallCmd.execute({ packages, cancellationToken: token });
                    }

                    // Execute install if needed
                    if (toInstall.length > 0) {
                        const installCmd = new CondaInstallCommand(manageCommandOptions);
                        const packages = parsePackageSpecs(toInstall);
                        await installCmd.execute({ packages, upgrade: options.upgrade, cancellationToken: token });
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

                    this.log.error('Error installing packages', e);
                    setImmediate(async () => {
                        await showErrorMessageWithLogs(CondaStrings.condaInstallError, this.log);
                    });
                }
            },
        );
    }

    async refresh(environment: PythonEnvironment): Promise<Package[] | undefined> {
        return withProgress(
            {
                location: ProgressLocation.Window,
                title: CondaStrings.condaRefreshingPackages,
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
            const listCmd = new CondaListCommand({
                pythonExecutable: 'conda',
                log: this.log,
            });
            const data = await listCmd.execute({ environmentPath: environment.environmentPath.fsPath } as any);
            const packages = (data ?? []).map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
            return packages;
        }
        return this.packages.get(environment.envId.id);
    }

    formatInstallSpec(packageName: string, version: string): string {
        // conda match spec syntax uses a single `=` for version pinning
        return `${packageName}=${version}`;
    }

    async getVersion(_environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            const versionCmd = new CondaVersionCommand({
                pythonExecutable: 'conda',
                log: this.log,
            });
            const versionString = await versionCmd.execute();
            return versionString ? (parse(versionString) ?? undefined) : undefined;
        } catch {
            return undefined;
        }
    }

    async getPackageAvailableVersions(
        _environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[] | undefined> {
        try {
            const availableVersionsCmd = new CondaAvailableVersionsCommand({
                pythonExecutable: 'conda',
                log: this.log,
            });
            const versionStrings = await availableVersionsCmd.execute({ packageName, pythonVersion: '' });
            return versionStrings.map((v) => parse(v)).filter((parsed) => parsed !== undefined) as Pep440Version[];
        } catch {
            return undefined;
        }
    }

    getPackageWatchTargets(environment: PythonEnvironment): RelativePattern[] {
        if (!environment.sysPrefix) {
            return [];
        }

        return [new RelativePattern(path.join(environment.sysPrefix, 'conda-meta'), '**/*.json')];
    }

    dispose() {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }
}
