import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
} from 'vscode';
import {
    DidChangePackagesEventArgs,
    IconPath,
    Package,
    PackageChangeKind,
    PackageInstallOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { getCommonCondaPackagesToInstall, installPackages, refreshPackages, uninstallPackages } from './condaUtils';
import { withProgress } from '../../common/window.apis';
import { showErrorMessage } from '../../common/errors/utils';
import { CondaStrings } from '../../common/localize';
import { getPackagesToUninstall } from '../common/utils';

function getChanges(before: Package[], after: Package[]): { kind: PackageChangeKind; pkg: Package }[] {
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];
    before.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.remove, pkg });
    });
    after.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.add, pkg });
    });
    return changes;
}

export class CondaPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(public readonly api: PythonEnvironmentApi, public readonly log: LogOutputChannel) {
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

    async install(environment: PythonEnvironment, packages?: string[], options?: PackageInstallOptions): Promise<void> {
        let selected: string[] = packages ?? [];

        if (selected.length === 0) {
            selected = (await getCommonCondaPackagesToInstall()) ?? [];
        }

        if (selected.length === 0) {
            return;
        }

        const installOptions = options ?? { upgrade: false };
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: CondaStrings.condaInstallingPackages,
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await installPackages(environment, selected, installOptions, this.api, this, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment: environment, manager: this, changes });
                } catch (e) {
                    if (e instanceof CancellationError) {
                        return;
                    }

                    this.log.error('Error installing packages', e);
                    setImmediate(async () => {
                        await showErrorMessage(CondaStrings.condaInstallError, this.log);
                    });
                }
            },
        );
    }

    async uninstall(environment: PythonEnvironment, packages?: Package[] | string[]): Promise<void> {
        let selected: Package[] | string[] = packages ?? [];
        if (selected.length === 0) {
            const installed = await this.getPackages(environment);
            if (!installed) {
                return;
            }
            selected = (await getPackagesToUninstall(installed)) ?? [];
        }

        if (selected.length === 0) {
            return;
        }

        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: CondaStrings.condaUninstallingPackages,
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await uninstallPackages(environment, selected, this.api, this, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment: environment, manager: this, changes });
                } catch (e) {
                    if (e instanceof CancellationError) {
                        return;
                    }

                    this.log.error('Error uninstalling packages', e);
                    setImmediate(async () => {
                        await showErrorMessage(CondaStrings.condaUninstallError, this.log);
                    });
                }
            },
        );
    }
    async refresh(context: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: CondaStrings.condaRefreshingPackages,
            },
            async () => {
                this.packages.set(context.envId.id, await refreshPackages(context, this.api, this));
            },
        );
    }

    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        if (!this.packages.has(environment.envId.id)) {
            await this.refresh(environment);
        }
        return this.packages.get(environment.envId.id);
    }

    dispose() {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }
}
