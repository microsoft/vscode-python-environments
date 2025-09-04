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
import { ProjectViews } from '../../common/localize';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { onDidChangeConfiguration } from '../../common/workspace.apis';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import {
    GlobalProjectItem,
    NoProjectEnvironment,
    ProjectEnvironment,
    ProjectEnvironmentInfo,
    ProjectItem,
    ProjectPackage,
    ProjectTreeItem,
    ProjectTreeItemKind,
} from './treeViewItems';

export class ProjectView implements TreeDataProvider<ProjectTreeItem> {
    private treeView: TreeView<ProjectTreeItem>;
    private _treeDataChanged: EventEmitter<ProjectTreeItem | ProjectTreeItem[] | null | undefined> = new EventEmitter<
        ProjectTreeItem | ProjectTreeItem[] | null | undefined
    >();
    private projectViews: Map<string, ProjectItem> = new Map();
    private revealMap: Map<string, ProjectEnvironment> = new Map();
    private packageRoots: Map<string, ProjectEnvironment> = new Map();
    private disposables: Disposable[] = [];
    private debouncedUpdateProject = createSimpleDebounce(500, () => this.updateProject());
    
    /**
     * Creates an instance of ProjectView, which provides a tree view for Python projects and their environments.
     * Sets up event listeners for project changes, environment changes, and configuration updates.
     * @param envManagers - The environment managers for handling Python environments
     * @param projectManager - The Python project manager for handling Python projects
     */
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

    /**
     * Initializes the project view by initializing the underlying project manager.
     */
    initialize(): void {
        this.projectManager.initialize();
    }

    /**
     * Updates the project tree view by firing a tree data changed event.
     * This causes the tree view to refresh and reload all items.
     */
    updateProject(): void {
        this._treeDataChanged.fire(undefined);
    }

    /**
     * Updates the package information for a specific Python environment.
     * Finds all project environment views that match the given environment ID and refreshes them.
     * @param e - The Python environment to update packages for
     */
    private updatePackagesForEnvironment(e: PythonEnvironment): void {
        const views: ProjectTreeItem[] = [];
        // Look for environments matching this environment ID and refresh them
        this.revealMap.forEach((v) => {
            if (v.environment.envId.id === e.envId.id) {
                views.push(v);
            }
        });
        this._treeDataChanged.fire(views);
    }

    /**
     * Internal method to reveal a project environment in the tree view.
     * Uses setImmediate to asynchronously reveal the view if the tree view is visible.
     * @param view - The project environment view to reveal
     */
    private revealInternal(view: ProjectEnvironment): void {
        if (this.treeView.visible) {
            setImmediate(async () => {
                await this.treeView.reveal(view);
            });
        }
    }

    /**
     * Reveals a project environment in the tree view based on either a URI or Python environment.
     * If a URI is provided, finds the associated project and reveals its environment.
     * If a Python environment is provided, finds the matching environment and reveals it.
     * @param context - Either a URI representing a project or a Python environment to reveal
     * @returns The Python environment that was revealed, or undefined if not found
     */
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

    /**
     * Gets the tree item representation for a given project tree element.
     * This is required by the TreeDataProvider interface.
     * @param element - The project tree item to get the tree item for
     * @returns The tree item representation of the element
     */
    getTreeItem(element: ProjectTreeItem): TreeItem | Thenable<TreeItem> {
        return element.treeItem;
    }

    /**
     * Returns the children of a given element in the project tree view:
     * - If element is undefined, returns root project items
     * - If element is a project, returns its environments
     * - If element is an environment, returns its packages
     * @param element - The tree item for which to get children
     * @returns Promise that resolves to an array of child tree items, or undefined if no children
     */
    async getChildren(element?: ProjectTreeItem | undefined): Promise<ProjectTreeItem[] | undefined> {
        if (element === undefined) {
            // Return the root items
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

            const environment = await this.envManagers.getEnvironment(uri);
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
            // Return packages directly under the environment

            const environmentItem = element as ProjectEnvironment;
            const parent = environmentItem.parent;
            const uri = parent.id === 'global' ? undefined : parent.project.uri;
            const pkgManager = this.envManagers.getPackageManager(uri);
            const environment = environmentItem.environment;

            if (!pkgManager) {
                return [new ProjectEnvironmentInfo(environmentItem, ProjectViews.noPackageManager)];
            }

            let packages = await pkgManager.getPackages(environment);
            if (!packages) {
                return [new ProjectEnvironmentInfo(environmentItem, ProjectViews.noPackages)];
            }

            // Store the reference for refreshing packages
            this.packageRoots.set(uri ? uri.fsPath : 'global', environmentItem);

            return packages.map((p) => new ProjectPackage(environmentItem, p, pkgManager));
        }

        //return nothing if the element is not a project, environment, or undefined
        return undefined;
    }
    
    /**
     * Gets the parent tree item for a given element.
     * This is required by the TreeDataProvider interface.
     * @param element - The tree item to get the parent for
     * @returns The parent tree item, or undefined if the element is a root item
     */
    getParent(element: ProjectTreeItem): ProviderResult<ProjectTreeItem> {
        return element.parent;
    }

    /**
     * Disposes of all resources used by the ProjectView.
     * Cleans up event listeners and other disposable resources.
     */
    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
