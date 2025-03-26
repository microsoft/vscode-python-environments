import { Event, EventEmitter, LogOutputChannel, MarkdownString, ProgressLocation, ThemeIcon, window } from 'vscode';
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
import { installPackages, refreshPackages, uninstallPackages } from './utils';
import { Disposable } from 'vscode-jsonrpc';
import { VenvManager } from './venvManager';
import { getWorkspacePackagesToInstall } from './pipUtils';
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

    async install(environment: PythonEnvironment, packages?: string[], options?: PackageInstallOptions): Promise<void> {
        let selected: string[] = packages ?? [];

        if (selected.length === 0) {
            const projects = this.venv.getProjectsByEnvironment(environment);
            selected = (await getWorkspacePackagesToInstall(this.api, options, projects)) ?? [];
        }

        if (selected.length === 0) {
            return;
        }

        const installOptions = options ?? { upgrade: false };
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await installPackages(environment, selected, installOptions, this.api, this, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
                } catch (e) {
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

        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Uninstalling packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await uninstallPackages(environment, this.api, this, selected, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment: environment, manager: this, changes });
                } catch (e) {
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

    async refresh(environment: PythonEnvironment): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing packages',
            },
            async () => {
                const before = this.packages.get(environment.envId.id) ?? [];
                const after = await refreshPackages(environment, this.api, this);
                const changes = getChanges(before, after);
                this.packages.set(environment.envId.id, after);
                if (changes.length > 0) {
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
                }
            },
        );
    }
    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        if (!this.packages.has(environment.envId.id)) {
            await this.refresh(environment);
        }
        return this.packages.get(environment.envId.id);
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }
}
