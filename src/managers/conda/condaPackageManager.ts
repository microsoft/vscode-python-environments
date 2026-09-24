import type { Pep440Version } from '@renovatebot/pep440';
import { compare } from '@renovatebot/pep440';
import * as path from 'path';
import {
    CancellationError,
    CancellationToken,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    RelativePattern,
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
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { CondaStrings } from '../../common/localize';
import { withProgress } from '../../common/window.apis';

import { updatePackagesAndNotify } from '../common/packageChanges';
import { parsePackageSpecs } from '../common/packageUtils';
import {
    CondaAvailableVersionsCommand,
    CondaInstallCommand,
    CondaListCommand,
    CondaListOutputError,
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
            if (options.runHeadless) {
                return;
            }
            const result = await getCommonCondaPackagesToInstall(environment, options, this.api);
            if (result) {
                toInstall = result.install;
                toUninstall = result.uninstall;
            } else {
                return;
            }
        }

        const execute = async (token?: CancellationToken): Promise<void> => {
            try {
                const commandOptions = {
                    pythonExecutable: 'conda',
                    condaEnvironmentPath: environment.environmentPath.fsPath,
                    log: this.log,
                };

                if (toUninstall.length > 0) {
                    const command = new CondaUninstallCommand(commandOptions);
                    await command.execute({
                        packages: parsePackageSpecs(toUninstall),
                        cancellationToken: token,
                    });
                }

                if (toInstall.length > 0) {
                    const command = new CondaInstallCommand(commandOptions);
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
                    () => this.fetchPackages(environment),
                );
            } catch (e) {
                if (e instanceof CancellationError) {
                    throw e;
                }
                this.log.error('Error installing packages', e);
                if (!options.runHeadless) {
                    setImmediate(async () => {
                        await showErrorMessageWithLogs(CondaStrings.condaInstallError, this.log);
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
                title: CondaStrings.condaInstallingPackages,
                cancellable: true,
            },
            (_progress, token) => execute(token),
        );
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: CondaStrings.condaRefreshingPackages,
            },
            async () => {
                const packages = await updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    },
                    () => this.fetchPackages(environment),
                );
                if (packages !== undefined) {
                    this.packages.set(environment.envId.id, packages);
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            return (await this.fetchPackages(environment)) ?? [];
        }
        return this.packages.get(environment.envId.id);
    }

    private async fetchPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        const listCmd = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environment.environmentPath.fsPath,
            log: this.log,
        });
        try {
            const data = await listCmd.execute();
            const packages = data.map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
            return packages;
        } catch (error) {
            if (error instanceof CondaListOutputError) {
                this.log.error('Error parsing installed Conda packages', error);
                return undefined;
            }
            throw error;
        }
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
            return await versionCmd.execute();
        } catch {
            return undefined;
        }
    }

    async getPackageAvailableVersions(
        _environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[]> {
        const availableVersionsCmd = new CondaAvailableVersionsCommand({
            pythonExecutable: 'conda',
            log: this.log,
        });
        const versions = await availableVersionsCmd.execute({ packageName, pythonVersion: '' });
        return versions.sort((a, b) => compare(b.public, a.public));
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
