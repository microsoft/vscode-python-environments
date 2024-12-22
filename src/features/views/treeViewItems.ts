import { TreeItem, TreeItemCollapsibleState, MarkdownString, Command, ThemeIcon } from 'vscode';
import { InternalEnvironmentManager, InternalPackageManager } from '../../internal.api';
import { PythonEnvironment, IconPath, Package, PythonProject } from '../../api';
import { removable } from './utils';
import { isActivatableEnvironment } from '../common/activation';

export enum EnvTreeItemKind {
    manager = 'python-env-manager',
    environment = 'python-env',
    noEnvironment = 'python-no-env',
    package = 'python-package',
    packageRoot = 'python-package-root',
    packageRootInfo = 'python-package-root-info',
    managerInfo = 'python-env-manager-info',
    environmentInfo = 'python-env-info',
    packageInfo = 'python-package-info',
}

export interface EnvTreeItem {
    kind: EnvTreeItemKind;
    treeItem: TreeItem;
    parent?: EnvTreeItem;
}

export class EnvManagerTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.manager;
    public readonly treeItem: TreeItem;
    public readonly parent: undefined;
    constructor(public readonly manager: InternalEnvironmentManager) {
        const item = new TreeItem(manager.displayName, TreeItemCollapsibleState.Collapsed);
        item.contextValue = this.getContextValue();
        item.description = manager.description;
        item.tooltip = manager.tooltip;
        item.iconPath = manager.iconPath;
        this.treeItem = item;
    }

    private getContextValue() {
        const create = this.manager.supportsCreate ? 'create' : '';
        const parts = ['pythonEnvManager', create, this.manager.id].filter(Boolean);
        return parts.join(';') + ';';
    }
}

export class PythonEnvTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.environment;
    public readonly treeItem: TreeItem;
    constructor(public readonly environment: PythonEnvironment, public readonly parent: EnvManagerTreeItem) {
        const item = new TreeItem(environment.displayName, TreeItemCollapsibleState.Collapsed);
        item.contextValue = this.getContextValue();
        item.description = environment.description;
        item.tooltip = environment.tooltip;
        item.iconPath = environment.iconPath;
        this.treeItem = item;
    }

    private getContextValue() {
        const activatable = isActivatableEnvironment(this.environment) ? 'activatable' : '';
        const remove = this.parent.manager.supportsRemove ? 'remove' : '';
        const parts = ['pythonEnvironment', remove, activatable].filter(Boolean);
        return parts.join(';') + ';';
    }
}

export class NoPythonEnvTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.environment;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: EnvManagerTreeItem,
        private readonly description?: string,
        private readonly tooltip?: string | MarkdownString,
        private readonly iconPath?: string | IconPath,
    ) {
        const item = new TreeItem(
            this.parent.manager.supportsCreate
                ? 'No environment found, click to create'
                : 'No python environments found.',
            TreeItemCollapsibleState.None,
        );
        item.contextValue = 'python-no-environment';
        item.description = this.description;
        item.tooltip = this.tooltip;
        item.iconPath = this.iconPath ?? new ThemeIcon('circle-slash');
        if (this.parent.manager.supportsCreate) {
            item.command = {
                command: 'python-envs.create',
                title: 'Create Environment',
                arguments: [this.parent],
            };
        }
        this.treeItem = item;
    }
}

export class PackageRootTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.packageRoot;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: PythonEnvTreeItem,
        public readonly manager: InternalPackageManager,
        public readonly environment: PythonEnvironment,
    ) {
        const item = new TreeItem('Packages', TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'python-package-root';
        item.description = manager.displayName;
        item.tooltip = 'Packages installed in this environment';
        this.treeItem = item;
    }
}

export class PackageTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.package;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly pkg: Package,
        public readonly parent: PackageRootTreeItem,
        public readonly manager: InternalPackageManager,
    ) {
        const item = new TreeItem(pkg.displayName);
        item.iconPath = pkg.iconPath;
        item.contextValue = 'python-package';
        item.description = pkg.description ?? pkg.version;
        item.tooltip = pkg.tooltip;
        this.treeItem = item;
    }
}

export class EnvInfoTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.environmentInfo;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: PythonEnvTreeItem,
        name: string,
        description?: string,
        tooltip?: string | MarkdownString,
        iconPath?: string | IconPath,
        command?: Command,
    ) {
        const item = new TreeItem(name, TreeItemCollapsibleState.None);
        item.contextValue = 'python-env-manager-info';
        item.description = description;
        item.tooltip = tooltip;
        this.treeItem = item;
        this.treeItem.iconPath = iconPath;
        this.treeItem.command = command;
    }
}

export class PackageRootInfoTreeItem implements EnvTreeItem {
    public readonly kind = EnvTreeItemKind.packageRootInfo;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: PackageRootTreeItem,
        name: string,
        description?: string,
        tooltip?: string | MarkdownString,
        iconPath?: string | IconPath,
        command?: Command,
    ) {
        const item = new TreeItem(name, TreeItemCollapsibleState.None);
        item.contextValue = 'python-package-root-info';
        item.description = description;
        item.tooltip = tooltip;
        this.treeItem = item;
        this.treeItem.iconPath = iconPath;
        this.treeItem.command = command;
    }
}

export enum ProjectTreeItemKind {
    project = 'project',
    environment = 'project-environment',
    none = 'project-no-environment',
    environmentInfo = 'environment-info',
    package = 'project-package',
    packageRoot = 'project-package-root',
    packageRootInfo = 'project-package-root-info',
}

export interface ProjectTreeItem {
    kind: ProjectTreeItemKind;
    parent?: ProjectTreeItem;
    id: string;
    treeItem: TreeItem;
}

export class ProjectItem implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.project;
    public readonly parent: undefined;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(public readonly project: PythonProject) {
        this.id = ProjectItem.getId(this.project);
        const item = new TreeItem(this.project.name, TreeItemCollapsibleState.Expanded);
        item.contextValue = removable(this.project) ? 'python-workspace-removable' : 'python-workspace';
        item.description = this.project.description;
        item.tooltip = this.project.tooltip;
        item.resourceUri = project.uri.fsPath.endsWith('.py') ? this.project.uri : undefined;
        item.iconPath = this.project.iconPath ?? (project.uri.fsPath.endsWith('.py') ? ThemeIcon.File : undefined);
        this.treeItem = item;
    }

    static getId(workspace: PythonProject): string {
        return workspace.uri.toString();
    }
}

export class GlobalProjectItem implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.project;
    public readonly parent: undefined;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor() {
        this.id = 'global';
        const item = new TreeItem('Global', TreeItemCollapsibleState.Expanded);
        item.contextValue = 'python-workspace';
        item.description = 'Global Python environment';
        item.tooltip = 'Global Python environment';
        item.iconPath = new ThemeIcon('globe');
        this.treeItem = item;
    }
}

export class ProjectEnvironment implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.environment;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(public readonly parent: ProjectItem, public readonly environment: PythonEnvironment) {
        this.id = this.getId(parent, environment);
        const item = new TreeItem(
            this.environment.displayName ?? this.environment.name,
            TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = 'python-env';
        item.description = this.environment.description;
        item.tooltip = this.environment.tooltip;
        item.iconPath = this.environment.iconPath;
        this.treeItem = item;
    }

    getId(workspace: ProjectItem, environment: PythonEnvironment): string {
        return `${workspace.id}>>>${environment.envId}`;
    }
}

export class NoProjectEnvironment implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.none;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly project: PythonProject | undefined,
        public readonly parent: ProjectItem,
        private readonly label: string,
        private readonly description?: string,
        private readonly tooltip?: string | MarkdownString,
        private readonly iconPath?: string | IconPath,
    ) {
        const randomStr1 = Math.random().toString(36).substring(2);
        this.id = `${this.parent.id}>>>none>>>${randomStr1}`;
        const item = new TreeItem(this.label, TreeItemCollapsibleState.None);
        item.contextValue = 'no-environment';
        item.description = this.description;
        item.tooltip = this.tooltip;
        item.iconPath = this.iconPath ?? new ThemeIcon('circle-slash');
        item.command = {
            command: 'python-envs.set',
            title: 'Set Environment',
            arguments: this.project ? [this.project.uri] : undefined,
        };
        this.treeItem = item;
    }
}

export class ProjectPackageRootTreeItem implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.packageRoot;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: ProjectEnvironment,
        public readonly manager: InternalPackageManager,
        public readonly environment: PythonEnvironment,
    ) {
        const item = new TreeItem('Packages', TreeItemCollapsibleState.Collapsed);
        this.id = `${this.parent.id}>>>packages`;
        item.contextValue = 'python-package-root';
        item.description = manager.displayName;
        item.tooltip = 'Packages installed in this environment';
        this.treeItem = item;
    }
}

export class NoPackagesEnvironment implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.none;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly project: PythonProject,
        public readonly parent: ProjectEnvironment,
        private readonly description?: string,
        private readonly tooltip?: string | MarkdownString,
        private readonly iconPath?: string | IconPath,
    ) {
        const randomStr1 = Math.random().toString(36).substring(2);
        this.id = `${this.parent.id}>>>packages-none>>>${randomStr1}`;
        const item = new TreeItem('Please select a package manager', TreeItemCollapsibleState.None);
        item.contextValue = 'no-packages';
        item.description = this.description;
        item.tooltip = this.tooltip;
        item.iconPath = this.iconPath ?? new ThemeIcon('circle-slash');
        item.command = {
            command: 'pythonEnvs.setPkgManager',
            title: 'Set Package Manager',
            arguments: [this.project.uri],
        };
        this.treeItem = item;
    }
}

export class ProjectEnvironmentInfo implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.environmentInfo;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: ProjectEnvironment,
        public readonly label: string,
        private readonly description?: string,
        private readonly tooltip?: string | MarkdownString,
        private readonly iconPath?: string | IconPath,
        private readonly command?: Command,
    ) {
        const randomStr1 = Math.random().toString(36).substring(2);
        const randomStr2 = Math.random().toString(36).substring(2);
        this.id = `${this.parent.id}>>>info>>>${randomStr1}-${randomStr2}`;
        const item = new TreeItem(this.label, TreeItemCollapsibleState.None);
        item.contextValue = 'python-env-manager-info';
        item.description = this.description;
        item.tooltip = this.tooltip;
        item.iconPath = this.iconPath;
        item.command = this.command;
        this.treeItem = item;
    }
}

export class ProjectPackage implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.package;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: ProjectPackageRootTreeItem,
        public readonly pkg: Package,
        public readonly manager: InternalPackageManager,
    ) {
        this.id = ProjectPackage.getId(parent, pkg);
        const item = new TreeItem(this.pkg.displayName, TreeItemCollapsibleState.None);
        item.iconPath = this.pkg.iconPath;
        item.contextValue = 'python-package';
        item.description = this.pkg.description ?? this.pkg.version;
        item.tooltip = this.pkg.tooltip;
        this.treeItem = item;
    }

    static getId(projectEnv: ProjectPackageRootTreeItem, pkg: Package): string {
        return `${projectEnv.id}>>>${pkg.pkgId}`;
    }
}

export class ProjectPackageRootInfoTreeItem implements ProjectTreeItem {
    public readonly kind = ProjectTreeItemKind.packageRootInfo;
    public readonly id: string;
    public readonly treeItem: TreeItem;
    constructor(
        public readonly parent: ProjectPackageRootTreeItem,
        name: string,
        description?: string,
        tooltip?: string | MarkdownString,
        iconPath?: string | IconPath,
        command?: Command,
    ) {
        const item = new TreeItem(name, TreeItemCollapsibleState.None);
        this.id = ProjectPackageRootInfoTreeItem.getId(parent, 'no-package');
        item.contextValue = 'python-package-root-info';
        item.description = description;
        item.tooltip = tooltip;
        this.treeItem = item;
        this.treeItem.iconPath = iconPath;
        this.treeItem.command = command;
    }
    static getId(projectEnv: ProjectPackageRootTreeItem, name: string): string {
        return `${projectEnv.id}>>>${name}`;
    }
}
