import * as path from 'path';
import { Event, EventEmitter, LogOutputChannel, MarkdownString, ProgressLocation, Uri, window } from 'vscode';
import {
    DidChangePackagesEventArgs,
    IconPath,
    Installable,
    Package,
    PackageChangeKind,
    PackageInstallOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { installPackages, refreshPackages, uninstallPackages } from './utils';
import { EXTENSION_ROOT_DIR } from '../../common/constants';
import { Disposable } from 'vscode-jsonrpc';
import { getProjectInstallable } from './venvUtils';
import { VenvManager } from './venvManager';

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
        public readonly logOutput: LogOutputChannel,
        private readonly venv: VenvManager,
    ) {
        this.name = 'pip';
        this.displayName = 'Pip';
        this.description = 'This package manager for python installs using pip.';
        this.tooltip = new MarkdownString('This package manager for python installs using `pip`.');
        this.iconPath = Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', '__icon__.py'));
    }
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
    readonly iconPath?: IconPath;

    async install(environment: PythonEnvironment, packages: string[], options: PackageInstallOptions): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
            },
            async () => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await installPackages(environment, packages, options, this.api, this);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
                } catch (e) {
                    this.logOutput.error('Error installing packages', e);
                    setImmediate(async () => {
                        const result = await window.showErrorMessage('Error installing packages', 'View Output');
                        if (result === 'View Output') {
                            this.logOutput.show();
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
            },
            async () => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await uninstallPackages(environment, this.api, this, packages);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment: environment, manager: this, changes });
                } catch (e) {
                    this.logOutput.error('Error uninstalling packages', e);
                    setImmediate(async () => {
                        const result = await window.showErrorMessage('Error installing packages', 'View Output');
                        if (result === 'View Output') {
                            this.logOutput.show();
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
                this.packages.set(environment.envId.id, await refreshPackages(environment, this.api, this));
            },
        );
    }
    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        if (!this.packages.has(environment.envId.id)) {
            await this.refresh(environment);
        }
        return this.packages.get(environment.envId.id);
    }
    async getInstallable(environment: PythonEnvironment): Promise<Installable[]> {
        const projects = this.venv.getProjectsByEnvironment(environment);
        return getProjectInstallable(this.api, projects);
    }
    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }
}
