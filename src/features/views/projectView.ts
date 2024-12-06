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
import { PythonEnvironment } from '../../api';
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
    GlobalProjectItem,
} from './treeViewItems';
import { onDidChangeConfiguration } from '../../common/workspace.apis';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { ProjectViews } from '../../common/localize';

export class ProjectView implements TreeDataProvider<ProjectTreeItem> {
    private treeView: TreeView<ProjectTreeItem>;
    private _treeDataChanged: EventEmitter<ProjectTreeItem | ProjectTreeItem[] | null | undefined> = new EventEmitter<
        ProjectTreeItem | ProjectTreeItem[] | null | undefined
    >();
    private projectViews: Map<string, ProjectItem> = new Map();
    private revealMap: Map<string, ProjectEnvironment> = new Map();
    private packageRoots: Map<string, ProjectPackageRootTreeItem> = new Map();
    private disposables: Disposable[] = [];
    private debouncedUpdateProject = createSimpleDebounce(500, () => this.updateProject());
    public constructor(private envManagers: EnvironmentManagers, private projectManager: PythonProjectManager) {
        this.treeView = window.createTreeView<ProjectTreeItem>('python-projects', {
            treeDataProvider: this,
        });
        this.disposables.push(
            new Disposable(() => {
                this.packageRoots.clear();
                this.revealMap.clear();
                this.projectViews.clear();
            }),
            this.treeView,
            this._treeDataChanged,
            this.projectManager.onDidChangeProjects(() => {
                this.debouncedUpdateProject.trigger();
            }),
            this.envManagers.onDidChangeEnvironment(() => {
                this.debouncedUpdateProject.trigger();
            }),
            this.envManagers.onDidChangeEnvironments(() => {
                this.debouncedUpdateProject.trigger();
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
                    this.debouncedUpdateProject.trigger();
                }
            }),
        );
    }

    initialize(): void {
        this.projectManager.initialize();
    }

    updateProject(): void {
        this._treeDataChanged.fire(undefined);
    }

    private updatePackagesForEnvironment(e: PythonEnvironment): void {
        const views: ProjectTreeItem[] = [];
        this.packageRoots.forEach((v) => {
            if (v.environment.envId.id === e.envId.id) {
                views.push(v);
            }
        });
        this._treeDataChanged.fire(views);
    }

    private revealInternal(view: ProjectEnvironment): void {
        if (this.treeView.visible) {
            setImmediate(async () => {
                await this.treeView.reveal(view);
            });
        }
    }

    reveal(context: Uri | PythonEnvironment): PythonEnvironment | undefined {
        if (context instanceof Uri) {
            const pw = this.projectManager.get(context);
            const key = pw ? pw.uri.fsPath : 'global';
            const view = this.revealMap.get(key);
            if (view) {
                this.revealInternal(view);
                return view.environment;
            }
        } else {
            const view = Array.from(this.revealMap.values()).find((v) => v.environment.envId.id === context.envId.id);
            if (view) {
                this.revealInternal(view);
                return view.environment;
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
            this.projectViews.clear();
            const views: ProjectTreeItem[] = [];
            const projects = this.projectManager.getProjects();
            projects.forEach((w) => {
                const view = new ProjectItem(w);
                this.projectViews.set(w.uri.fsPath, view);
                views.push(view);
            });

            if (projects.length === 0) {
                views.push(new GlobalProjectItem());
            }

            return views;
        }

        if (element.kind === ProjectTreeItemKind.project) {
            const projectItem = element as ProjectItem;
            if (this.envManagers.managers.length === 0) {
                return [
                    new NoProjectEnvironment(
                        projectItem.project,
                        projectItem,
                        ProjectViews.waitingForEnvManager,
                        undefined,
                        undefined,
                        '$(loading~spin)',
                    ),
                ];
            }

            const uri = projectItem.id === 'global' ? undefined : projectItem.project.uri;
            const manager = this.envManagers.getEnvironmentManager(uri);
            if (!manager) {
                return [
                    new NoProjectEnvironment(
                        projectItem.project,
                        projectItem,
                        ProjectViews.noEnvironmentManager,
                        ProjectViews.noEnvironmentManagerDescription,
                    ),
                ];
            }

            const environment = await manager?.get(uri);
            if (!environment) {
                return [
                    new NoProjectEnvironment(
                        projectItem.project,
                        projectItem,
                        `${ProjectViews.noEnvironmentProvided} ${manager.displayName}`,
                    ),
                ];
            }
            const view = new ProjectEnvironment(projectItem, environment);
            this.revealMap.set(uri ? uri.fsPath : 'global', view);
            return [view];
        }

        if (element.kind === ProjectTreeItemKind.environment) {
            const environmentItem = element as ProjectEnvironment;
            const parent = environmentItem.parent;
            const uri = parent.id === 'global' ? undefined : parent.project.uri;
            const pkgManager = this.envManagers.getPackageManager(uri);
            const environment = environmentItem.environment;

            const views: ProjectTreeItem[] = [];

            if (pkgManager) {
                const item = new ProjectPackageRootTreeItem(environmentItem, pkgManager, environment);
                this.packageRoots.set(uri ? uri.fsPath : 'global', item);
                views.push(item);
            } else {
                views.push(new ProjectEnvironmentInfo(environmentItem, ProjectViews.noPackageManager));
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
                views.push(new ProjectPackageRootInfoTreeItem(root, ProjectViews.noPackages));
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
