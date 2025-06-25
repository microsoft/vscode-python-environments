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
import { onDidChangeConfiguration, onDidDeleteFiles, onDidRenameFiles } from '../../common/workspace.apis';
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
            onDidRenameFiles((e) => {
                this.handleFileRenames(e);
            }),
            onDidDeleteFiles((e) => {
                this.handleFileDeletions(e);
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
        // Look for environments matching this environment ID and refresh them
        this.revealMap.forEach((v) => {
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

    /**
     * Returns the children of a given element in the project tree view:
     * If param is undefined, return root project items
     * If param is a project, returns its environments.
     * If param is an environment, returns its packages.
     * @param element The tree item for which to get children.
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
    getParent(element: ProjectTreeItem): ProviderResult<ProjectTreeItem> {
        return element.parent;
    }

    private async handleFileRenames(e: {
        readonly files: ReadonlyArray<{ readonly oldUri: Uri; readonly newUri: Uri }>;
    }): Promise<void> {
        const projects = this.projectManager.getProjects();

        for (const { oldUri, newUri } of e.files) {
            // Check if any project matches the old URI exactly or is contained within it
            const affectedProjects = projects.filter((project) => {
                const projectPath = project.uri.fsPath;
                const oldPath = oldUri.fsPath;

                // Check if the project path is the same as or is a child of the renamed path
                return (
                    projectPath === oldPath ||
                    projectPath.startsWith(oldPath + '/') ||
                    projectPath.startsWith(oldPath + '\\')
                );
            });

            for (const project of affectedProjects) {
                const projectPath = project.uri.fsPath;
                const oldPath = oldUri.fsPath;
                const newPath = newUri.fsPath;

                // Calculate the new project path
                let newProjectPath: string;
                if (projectPath === oldPath) {
                    // Project path is exactly the renamed path
                    newProjectPath = newPath;
                } else {
                    // Project path is a child of the renamed path
                    const relativePath = projectPath.substring(oldPath.length);
                    newProjectPath = newPath + relativePath;
                }

                const newProjectUri = Uri.file(newProjectPath);
                await this.projectManager.modifyProject(project.uri, undefined, newProjectUri);
            }

            if (affectedProjects.length > 0) {
                // only trigger update if there are affected projects
                this.debouncedUpdateProject.trigger();
            }
        }
    }

    private handleFileDeletions(e: { readonly files: ReadonlyArray<Uri> }): void {
        const projects = this.projectManager.getProjects();

        for (const deletedUri of e.files) {
            // Check if any project matches the deleted URI exactly or is contained within it
            const affectedProjects = projects.filter((project) => {
                const projectPath = project.uri.fsPath;
                const deletedPath = deletedUri.fsPath;

                // Check if the project path is the same as or is a child of the deleted path
                return (
                    projectPath === deletedPath ||
                    projectPath.startsWith(deletedPath + '/') ||
                    projectPath.startsWith(deletedPath + '\\')
                );
            });

            if (affectedProjects.length > 0) {
                this.projectManager.remove(affectedProjects);
                // If there are affected projects, trigger an update
                this.debouncedUpdateProject.trigger();
            }
        }
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
