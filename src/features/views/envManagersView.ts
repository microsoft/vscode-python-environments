import { Disposable, Event, EventEmitter, ProviderResult, TreeDataProvider, TreeItem, TreeView, window } from 'vscode';
import { PythonEnvironment } from '../../api';
import {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagers,
    InternalDidChangeEnvironmentsEventArgs,
    InternalDidChangePackagesEventArgs,
    InternalEnvironmentManager,
    InternalPackageManager,
} from '../../internal.api';
import { traceError } from '../../common/logging';
import {
    EnvTreeItem,
    EnvManagerTreeItem,
    PythonEnvTreeItem,
    PackageRootTreeItem,
    PackageTreeItem,
    EnvTreeItemKind,
    NoPythonEnvTreeItem,
    EnvInfoTreeItem,
    PackageRootInfoTreeItem,
} from './treeViewItems';

export class EnvManagerView implements TreeDataProvider<EnvTreeItem>, Disposable {
    private treeView: TreeView<EnvTreeItem>;
    private _treeDataChanged: EventEmitter<EnvTreeItem | EnvTreeItem[] | null | undefined> = new EventEmitter<
        EnvTreeItem | EnvTreeItem[] | null | undefined
    >();
    private _viewsManagers = new Map<string, EnvManagerTreeItem>();
    private _viewsEnvironments = new Map<string, PythonEnvTreeItem>();
    private _viewsPackageRoots = new Map<string, PackageRootTreeItem>();
    private _viewsPackages = new Map<string, PackageTreeItem>();
    private disposables: Disposable[] = [];

    public constructor(public providers: EnvironmentManagers) {
        this.treeView = window.createTreeView<EnvTreeItem>('env-managers', {
            treeDataProvider: this,
        });

        this.disposables.push(
            this.treeView,
            this._treeDataChanged,
            this.providers.onDidChangeEnvironments((e: InternalDidChangeEnvironmentsEventArgs) => {
                this.onDidChangeEnvironments(e);
            }),
            this.providers.onDidChangeEnvironmentManager((m: DidChangeEnvironmentManagerEventArgs) => {
                this.onDidChangeEnvironmentManager(m);
            }),

            this.providers.onDidChangePackages((p: InternalDidChangePackagesEventArgs) => {
                this.onDidChangePackages(p);
            }),
            this.providers.onDidChangePackageManager((p: DidChangePackageManagerEventArgs) => {
                this.onDidChangePackageManager(p);
            }),
        );
    }

    dispose() {
        this._viewsManagers.clear();
        this._viewsEnvironments.clear();
        this._viewsPackages.clear();
        this.disposables.forEach((d) => d.dispose());
    }

    private fireDataChanged(item: EnvTreeItem | EnvTreeItem[] | null | undefined) {
        if (Array.isArray(item)) {
            if (item.length > 0) {
                this._treeDataChanged.fire(item);
            }
        } else {
            this._treeDataChanged.fire(item);
        }
    }

    onDidChangeTreeData: Event<void | EnvTreeItem | EnvTreeItem[] | null | undefined> = this._treeDataChanged.event;

    getTreeItem(element: EnvTreeItem): TreeItem | Thenable<TreeItem> {
        return element.treeItem;
    }

    async getChildren(element?: EnvTreeItem | undefined): Promise<EnvTreeItem[] | undefined> {
        if (!element) {
            return Array.from(this._viewsManagers.values());
        }
        if (element.kind === EnvTreeItemKind.manager) {
            const manager = (element as EnvManagerTreeItem).manager;
            const views: EnvTreeItem[] = [];
            const envs = await manager.getEnvironments('all');
            envs.forEach((env) => {
                const view = this._viewsEnvironments.get(env.envId.id);
                if (view) {
                    views.push(view);
                }
            });

            if (views.length === 0) {
                views.push(new NoPythonEnvTreeItem(element as EnvManagerTreeItem));
            }
            return views;
        }

        if (element.kind === EnvTreeItemKind.environment) {
            const environment = (element as PythonEnvTreeItem).environment;
            const envManager = (element as PythonEnvTreeItem).parent.manager;
            const pkgManager = this.getSupportedPackageManager(envManager);
            const parent = element as PythonEnvTreeItem;
            const views: EnvTreeItem[] = [];

            if (pkgManager) {
                const item = new PackageRootTreeItem(parent, pkgManager, environment);
                this._viewsPackageRoots.set(environment.envId.id, item);
                views.push(item);
            } else {
                views.push(new EnvInfoTreeItem(parent, 'No package manager found'));
            }

            return views;
        }

        if (element.kind === EnvTreeItemKind.packageRoot) {
            const root = element as PackageRootTreeItem;
            const manager = root.manager;
            const environment = root.environment;

            let packages = await manager.getPackages(environment);
            const views: EnvTreeItem[] = [];

            if (packages) {
                views.push(...packages.map((p) => new PackageTreeItem(p, root, manager)));
            } else {
                views.push(new PackageRootInfoTreeItem(root, 'No packages found'));
            }

            return views;
        }
    }

    getParent(element: EnvTreeItem): ProviderResult<EnvTreeItem> {
        return element.parent;
    }

    async reveal(environment?: PythonEnvironment) {
        if (environment && this.treeView.visible) {
            const view = this._viewsEnvironments.get(environment.envId.id);
            if (view) {
                await this.treeView.reveal(view);
            }
        }
    }

    private getSupportedPackageManager(manager: InternalEnvironmentManager): InternalPackageManager | undefined {
        return this.providers.getPackageManager(manager.preferredPackageManagerId);
    }

    private onDidChangeEnvironmentManager(args: DidChangeEnvironmentManagerEventArgs) {
        if (args.kind === 'registered') {
            this._viewsManagers.set(args.manager.id, new EnvManagerTreeItem(args.manager));
            this.fireDataChanged(undefined);
        } else {
            if (this._viewsManagers.delete(args.manager.id)) {
                this.fireDataChanged(undefined);
            }
        }
    }

    private onDidChangeEnvironments(args: InternalDidChangeEnvironmentsEventArgs) {
        const managerView = this._viewsManagers.get(args.manager.id);
        if (!managerView) {
            traceError(`No manager found: ${args.manager.id}`);
            traceError(`Managers: ${this.providers.managers.map((m) => m.id).join(', ')}`);
            return;
        }

        // All removes should happen first, then adds
        const sorted = args.changes.sort((a, b) => {
            if (a.kind === 'remove' && b.kind === 'add') {
                return -1;
            }
            if (a.kind === 'add' && b.kind === 'remove') {
                return 1;
            }
            return 0;
        });

        sorted.forEach((e) => {
            if (managerView) {
                if (e.kind === 'add') {
                    this._viewsEnvironments.set(
                        e.environment.envId.id,
                        new PythonEnvTreeItem(e.environment, managerView),
                    );
                } else if (e.kind === 'remove') {
                    this._viewsEnvironments.delete(e.environment.envId.id);
                }
            }
        });
        this.fireDataChanged([managerView]);
    }

    private onDidChangePackages(args: InternalDidChangePackagesEventArgs) {
        const pkgRoot = this._viewsPackageRoots.get(args.environment.envId.id);
        if (pkgRoot) {
            this.fireDataChanged(pkgRoot);
        }
    }

    private onDidChangePackageManager(args: DidChangePackageManagerEventArgs) {
        const roots = Array.from(this._viewsPackageRoots.values()).filter((r) => r.manager.id === args.manager.id);
        this.fireDataChanged(roots);
    }
}
