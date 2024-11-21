import {
    Disposable,
    Event,
    EventEmitter,
    ProviderResult,
    TreeDataProvider,
    TreeItem,
    TreeView,
    Uri,
    window,
} from 'vscode';
import { PythonProject, PythonEnvironment } from '../../api';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import {
    ProjectTreeItem,
    ProjectItem,
    ProjectEnvironment,
    ProjectPackageRootTreeItem,
    ProjectTreeItemKind,
    NoProjectEnvironment,
    ProjectEnvironmentInfo,
    ProjectPackage,
    ProjectPackageRootInfoTreeItem,
} from './treeViewItems';
import { onDidChangeConfiguration } from '../../common/workspace.apis';

export class WorkspaceView implements TreeDataProvider<ProjectTreeItem> {
    private treeView: TreeView<ProjectTreeItem>;
    private _treeDataChanged: EventEmitter<ProjectTreeItem | ProjectTreeItem[] | null | undefined> = new EventEmitter<
        ProjectTreeItem | ProjectTreeItem[] | null | undefined
    >();
    private _projectViews: Map<string, ProjectItem> = new Map();
    private _environmentViews: Map<string, ProjectEnvironment> = new Map();
    private _viewsPackageRoots: Map<string, ProjectPackageRootTreeItem> = new Map();
    private disposables: Disposable[] = [];
    public constructor(private envManagers: EnvironmentManagers, private projectManager: PythonProjectManager) {
        this.treeView = window.createTreeView<ProjectTreeItem>('python-projects', {
            treeDataProvider: this,
        });
        this.disposables.push(
            this.treeView,
            this._treeDataChanged,
            this.projectManager.onDidChangeProjects(() => {
                this.updateProject();
            }),
            this.envManagers.onDidChangeEnvironment((e) => {
                this.updateProject(e.uri ? this.projectManager.get(e.uri) : undefined);
            }),
            this.envManagers.onDidChangeEnvironments(() => {
                this.updateProject();
            }),
            this.envManagers.onDidChangePackages((e) => {
                this.updatePackagesForEnvironment(e.environment);
            }),
            onDidChangeConfiguration(async (e) => {
                if (
                    e.affectsConfiguration('python-envs.defaultEnvManager') ||
                    e.affectsConfiguration('python-envs.pythonProjects') ||
                    e.affectsConfiguration('python-envs.defaultPackageManager')
                ) {
                    this.updateProject();
                }
            }),
        );
    }

    initialize(): void {
        this.projectManager.initialize();
    }

    updateProject(p?: PythonProject | PythonProject[]): void {
        if (Array.isArray(p)) {
            const views: ProjectItem[] = [];
            p.forEach((w) => {
                const view = this._projectViews.get(ProjectItem.getId(w));
                if (view) {
                    this._environmentViews.delete(view.id);
                    views.push(view);
                }
            });
            this._treeDataChanged.fire(views);
        } else if (p) {
            const view = this._projectViews.get(ProjectItem.getId(p));
            if (view) {
                this._environmentViews.delete(view.id);
                this._treeDataChanged.fire(view);
            }
        } else {
            this._projectViews.clear();
            this._environmentViews.clear();
            this._treeDataChanged.fire(undefined);
        }
    }

    private updatePackagesForEnvironment(e: PythonEnvironment): void {
        const views: ProjectTreeItem[] = [];
        this._viewsPackageRoots.forEach((v) => {
            if (v.environment.envId.id === e.envId.id) {
                views.push(v);
            }
        });
        this._treeDataChanged.fire(views);
    }

    async reveal(uri: Uri): Promise<PythonEnvironment | undefined> {
        if (this.treeView.visible) {
            const pw = this.projectManager.get(uri);
            if (pw) {
                const view = this._environmentViews.get(ProjectItem.getId(pw));
                if (view) {
                    await this.treeView.reveal(view);
                }
                return view?.environment;
            }
        }

        return undefined;
    }

    onDidChangeTreeData: Event<void | ProjectTreeItem | ProjectTreeItem[] | null | undefined> | undefined =
        this._treeDataChanged.event;

    getTreeItem(element: ProjectTreeItem): TreeItem | Thenable<TreeItem> {
        return element.treeItem;
    }

    async getChildren(element?: ProjectTreeItem | undefined): Promise<ProjectTreeItem[] | undefined> {
        if (element === undefined) {
            const views: ProjectTreeItem[] = [];
            this.projectManager.getProjects().forEach((w) => {
                const id = ProjectItem.getId(w);
                const view = this._projectViews.get(id) ?? new ProjectItem(w);
                this._projectViews.set(ProjectItem.getId(w), view);
                views.push(view);
            });

            return views;
        }

        if (element.kind === ProjectTreeItemKind.project) {
            const projectItem = element as ProjectItem;
            const envView = this._environmentViews.get(projectItem.id);

            if (this.envManagers.managers.length === 0) {
                this._environmentViews.delete(projectItem.id);
                return [
                    new NoProjectEnvironment(
                        projectItem.project,
                        projectItem,
                        'Waiting for environment managers to load',
                        undefined,
                        undefined,
                        '$(loading~spin)',
                    ),
                ];
            }

            const manager = this.envManagers.getEnvironmentManager(projectItem.project.uri);
            if (!manager) {
                this._environmentViews.delete(projectItem.id);
                return [
                    new NoProjectEnvironment(
                        projectItem.project,
                        projectItem,
                        'Environment manager not found',
                        'Install an environment manager to get started. If you have installed then it might be loading.',
                    ),
                ];
            }

            const environment = await manager?.get(projectItem.project.uri);
            if (!environment) {
                this._environmentViews.delete(projectItem.id);
                return [
                    new NoProjectEnvironment(
                        projectItem.project,
                        projectItem,
                        `No environment provided by ${manager.displayName}`,
                    ),
                ];
            }

            const envItemId = ProjectEnvironment.getId(projectItem, environment);
            if (envView && envView.id === envItemId) {
                return [envView];
            }

            this._environmentViews.delete(projectItem.id);
            const view = new ProjectEnvironment(projectItem, environment);
            this._environmentViews.set(projectItem.id, view);
            return [view];
        }

        if (element.kind === ProjectTreeItemKind.environment) {
            const environmentItem = element as ProjectEnvironment;
            const parent = environmentItem.parent;
            const pkgManager = this.envManagers.getPackageManager(parent.project.uri);
            const environment = environmentItem.environment;

            const views: ProjectTreeItem[] = [];

            if (pkgManager) {
                const item = new ProjectPackageRootTreeItem(environmentItem, pkgManager, environment);
                this._viewsPackageRoots.set(environment.envId.id, item);
                views.push(item);
            } else {
                views.push(new ProjectEnvironmentInfo(environmentItem, 'No package manager found'));
            }
            return views;
        }

        if (element.kind === ProjectTreeItemKind.packageRoot) {
            const root = element as ProjectPackageRootTreeItem;
            const manager = root.manager;
            const environment = root.environment;
            let packages = await manager.getPackages(environment);
            const views: ProjectTreeItem[] = [];

            if (packages) {
                return packages.map((p) => new ProjectPackage(root, p, manager));
            } else {
                views.push(new ProjectPackageRootInfoTreeItem(root, 'No packages found'));
            }
        }

        return undefined;
    }
    getParent(element: ProjectTreeItem): ProviderResult<ProjectTreeItem> {
        return element.parent;
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
