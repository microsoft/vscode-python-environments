import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    window,
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
import { installPackages, refreshPackages, uninstallPackages } from './condaUtils';

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
        this.description = 'Conda package manager';
        this.tooltip = 'Conda package manager';
    }
    name: string;
    displayName?: string;
    description?: string;
    tooltip?: string | MarkdownString;
    iconPath?: IconPath;

    async install(environment: PythonEnvironment, packages: string[], options: PackageInstallOptions): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await installPackages(environment, packages, options, this.api, this, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment: environment, manager: this, changes });
                } catch (e) {
                    if (e instanceof CancellationError) {
                        return;
                    }

                    this.log.error('Error installing packages', e);
                    setImmediate(async () => {
                        const result = await window.showErrorMessage('Error installing packages', 'View Output');
                        if (result === 'View Output') {
                            this.log.show();
                        }
                    });
                }
            },
        );
    }

    async uninstall(environment: PythonEnvironment, packages: Package[] | string[]): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Uninstalling packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await uninstallPackages(environment, packages, this.api, this, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment: environment, manager: this, changes });
                } catch (e) {
                    if (e instanceof CancellationError) {
                        return;
                    }

                    this.log.error('Error uninstalling packages', e);
                    setImmediate(async () => {
                        const result = await window.showErrorMessage('Error installing packages', 'View Output');
                        if (result === 'View Output') {
                            this.log.show();
                        }
                    });
                }
            },
        );
    }
    async refresh(context: PythonEnvironment): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing packages',
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
