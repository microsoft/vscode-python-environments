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
    PackageChangeKind,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { managePackages, normalizePackageName, refreshPipDirectPackageNames, refreshPipPackages } from './utils';
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

        const manageOptions = {
            ...options,
            install: toInstall,
            uninstall: toUninstall,
        };
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    await managePackages(environment, manageOptions, this, token);
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
            const data = await refreshPipPackages(environment, this.log);
            const packages = (data ?? []).map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
            return packages;
        }
        return this.packages.get(environment.envId.id);
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }

    /**
     * Returns direct (non-transitive) package names using `pip list --not-required` or `uv pip tree --depth=0`.
     *
     * Note: These commands return packages with no installed dependents (leaf packages), not packages
     * the user explicitly installed. pip/uv do not track install intent.
     */
    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        const data = await refreshPipDirectPackageNames(environment, this.log);
        return data ? new Set(data.map(normalizePackageName)) : undefined;
    }
}
