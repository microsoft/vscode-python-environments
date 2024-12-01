import { Disposable, Event, LogOutputChannel, MarkdownString, Uri } from 'vscode';
import {
    PythonEnvironment,
    EnvironmentManager,
    PackageManager,
    Package,
    IconPath,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    DidChangePackagesEventArgs,
    PythonProject,
    RefreshEnvironmentsScope,
    GetEnvironmentsScope,
    CreateEnvironmentScope,
    SetEnvironmentScope,
    GetEnvironmentScope,
    PythonEnvironmentId,
    PythonEnvironmentExecutionInfo,
    PythonEnvironmentInfo,
    PackageChangeKind,
    PackageId,
    PackageInfo,
    PythonProjectCreator,
    ResolveEnvironmentContext,
    PackageInstallOptions,
    Installable,
} from './api';
import { CreateEnvironmentNotSupported, RemoveEnvironmentNotSupported } from './common/errors/NotSupportedError';

export type EnvironmentManagerScope = undefined | string | Uri | PythonEnvironment;
export type PackageManagerScope = undefined | string | Uri | PythonEnvironment | Package;

export interface PackageEventArg {
    package: Package;
    manager: InternalPackageManager;
    environment: PythonEnvironment;
}
export type PackageCommandOptions =
    | {
          uri: Uri;
          packages?: string[];
      }
    | {
          packageManager: PackageManager;
          environment: PythonEnvironment;
          packages?: string[];
      };

export interface DidChangeEnvironmentManagerEventArgs {
    kind: 'registered' | 'unregistered';
    manager: InternalEnvironmentManager;
}

export interface DidChangePackageManagerEventArgs {
    kind: 'registered' | 'unregistered';
    manager: InternalPackageManager;
}

export interface InternalDidChangePackagesEventArgs {
    environment: PythonEnvironment;
    manager: InternalPackageManager;
    changes: { kind: PackageChangeKind; pkg: Package }[];
}

export interface InternalDidChangeEnvironmentsEventArgs {
    manager: InternalEnvironmentManager;
    changes: DidChangeEnvironmentsEventArgs;
}

export interface EnvironmentManagers extends Disposable {
    registerEnvironmentManager(manager: EnvironmentManager): Disposable;
    registerPackageManager(manager: PackageManager): Disposable;

    onDidChangeEnvironments: Event<InternalDidChangeEnvironmentsEventArgs>;
    onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs>;
    onDidChangeEnvironmentFiltered: Event<DidChangeEnvironmentEventArgs>;
    onDidChangePackages: Event<InternalDidChangePackagesEventArgs>;

    onDidChangeEnvironmentManager: Event<DidChangeEnvironmentManagerEventArgs>;
    onDidChangePackageManager: Event<DidChangePackageManagerEventArgs>;

    getEnvironmentManager(scope: EnvironmentManagerScope): InternalEnvironmentManager | undefined;
    getPackageManager(scope: PackageManagerScope): InternalPackageManager | undefined;

    managers: InternalEnvironmentManager[];
    packageManagers: InternalPackageManager[];

    clearCache(scope: EnvironmentManagerScope): Promise<void>;

    setEnvironment(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void>;
    setEnvironments(scope: Uri[] | string, environment?: PythonEnvironment): Promise<void>;
    getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined>;

    getProjectEnvManagers(uris: Uri[]): InternalEnvironmentManager[];
}

export class InternalEnvironmentManager implements EnvironmentManager {
    public constructor(public readonly id: string, private readonly manager: EnvironmentManager) {}

    public get name(): string {
        return this.manager.name;
    }
    public get displayName(): string {
        return this.manager.displayName ?? this.name;
    }
    public get preferredPackageManagerId(): string {
        return this.manager.preferredPackageManagerId;
    }
    public get description(): string | undefined {
        return this.manager.description;
    }
    public get tooltip(): string | MarkdownString | undefined {
        return this.manager.tooltip;
    }
    public get iconPath(): IconPath | undefined {
        return this.manager.iconPath;
    }
    public get log(): LogOutputChannel | undefined {
        return this.manager.log;
    }

    public get supportsCreate(): boolean {
        return this.manager.create !== undefined;
    }

    create(scope: CreateEnvironmentScope): Promise<PythonEnvironment | undefined> {
        if (this.manager.create) {
            return this.manager.create(scope);
        }

        return Promise.reject(new CreateEnvironmentNotSupported(`Create Environment not supported by: ${this.id}`));
    }

    public get supportsRemove(): boolean {
        return this.manager.remove !== undefined;
    }

    remove(scope: PythonEnvironment): Promise<void> {
        return this.manager.remove
            ? this.manager.remove(scope)
            : Promise.reject(new RemoveEnvironmentNotSupported(`Remove Environment not supported by: ${this.id}`));
    }

    refresh(options: RefreshEnvironmentsScope): Promise<void> {
        return this.manager.refresh(options);
    }

    getEnvironments(options: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        return this.manager.getEnvironments(options);
    }

    onDidChangeEnvironments(handler: (e: DidChangeEnvironmentsEventArgs) => void): Disposable {
        return this.manager.onDidChangeEnvironments
            ? this.manager.onDidChangeEnvironments(handler)
            : new Disposable(() => {});
    }

    set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        return this.manager.set(scope, environment);
    }
    get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return this.manager.get(scope);
    }

    onDidChangeEnvironment(handler: (e: DidChangeEnvironmentEventArgs) => void): Disposable {
        return this.manager.onDidChangeEnvironment
            ? this.manager.onDidChangeEnvironment(handler)
            : new Disposable(() => {});
    }

    resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return this.manager.resolve(context);
    }

    public equals(other: EnvironmentManager): boolean {
        return this.manager === other;
    }

    public supportsClearCache(): boolean {
        return this.manager.clearCache !== undefined;
    }

    public clearCache(): Promise<void> {
        return this.manager.clearCache ? this.manager.clearCache() : Promise.resolve();
    }
}

export class InternalPackageManager implements PackageManager {
    public constructor(public readonly id: string, private readonly manager: PackageManager) {}

    public get name(): string {
        return this.manager.name;
    }
    public get displayName(): string {
        return this.manager.displayName ?? this.name;
    }
    public get description(): string | undefined {
        return this.manager.description;
    }
    public get tooltip(): string | MarkdownString | undefined {
        return this.manager.tooltip;
    }
    public get iconPath(): IconPath | undefined {
        return this.manager.iconPath;
    }
    public get logOutput(): LogOutputChannel | undefined {
        return this.manager.logOutput;
    }

    install(environment: PythonEnvironment, packages: string[], options: PackageInstallOptions): Promise<void> {
        return this.manager.install(environment, packages, options);
    }
    uninstall(environment: PythonEnvironment, packages: Package[] | string[]): Promise<void> {
        return this.manager.uninstall(environment, packages);
    }
    refresh(environment: PythonEnvironment): Promise<void> {
        return this.manager.refresh(environment);
    }
    getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        return this.manager.getPackages(environment);
    }

    public get supportsGetInstallable(): boolean {
        return this.manager.getInstallable !== undefined;
    }

    getInstallable(environment: PythonEnvironment): Promise<Installable[]> {
        return this.manager.getInstallable ? this.manager.getInstallable(environment) : Promise.resolve([]);
    }

    onDidChangePackages(handler: (e: DidChangePackagesEventArgs) => void): Disposable {
        return this.manager.onDidChangePackages ? this.manager.onDidChangePackages(handler) : new Disposable(() => {});
    }
    equals(other: PackageManager): boolean {
        return this.manager === other;
    }
}

export interface PythonProjectManager extends Disposable {
    initialize(): void;
    create(
        name: string,
        uri: Uri,
        options?: { description?: string; tooltip?: string | MarkdownString; iconPath?: IconPath },
    ): PythonProject;
    add(pyWorkspace: PythonProject | PythonProject[]): void;
    remove(pyWorkspace: PythonProject | PythonProject[]): void;
    getProjects(uris?: Uri[]): ReadonlyArray<PythonProject>;
    get(uri: Uri): PythonProject | undefined;
    onDidChangeProjects: Event<PythonProject[] | undefined>;
}

export interface PythonProjectSettings {
    path: string;
    envManager: string;
    packageManager: string;
}

export class PythonEnvironmentImpl implements PythonEnvironment {
    public readonly name: string;
    public readonly displayName: string;
    public readonly shortDisplayName?: string;
    public readonly displayPath: string;
    public readonly version: string;
    public readonly environmentPath: Uri;
    public readonly description?: string;
    public readonly tooltip?: string | MarkdownString;
    public readonly iconPath?: IconPath;
    public readonly execInfo?: PythonEnvironmentExecutionInfo;
    public readonly sysPrefix: string;

    constructor(public readonly envId: PythonEnvironmentId, info: PythonEnvironmentInfo) {
        this.name = info.name;
        this.displayName = info.displayName ?? this.name;
        this.shortDisplayName = info.shortDisplayName;
        this.displayPath = info.displayPath;
        this.version = info.version;
        this.environmentPath = info.environmentPath;
        this.description = info.description;
        this.tooltip = info.tooltip;
        this.iconPath = info.iconPath;
        this.execInfo = info.execInfo;
        this.sysPrefix = info.sysPrefix;
    }
}

export class PythonPackageImpl implements Package {
    public readonly name: string;
    public readonly displayName: string;
    public readonly version?: string;
    public readonly description?: string;
    public readonly tooltip?: string | MarkdownString;
    public readonly iconPath?: IconPath;
    public readonly uris?: readonly Uri[];

    constructor(public readonly pkgId: PackageId, info: PackageInfo) {
        this.name = info.name;
        this.displayName = info.displayName ?? this.name;
        this.version = info.version;
        this.description = info.description;
        this.tooltip = info.tooltip;
        this.iconPath = info.iconPath;
        this.uris = info.uris;
    }
}

export class PythonProjectsImpl implements PythonProject {
    name: string;
    uri: Uri;
    description?: string;
    tooltip?: string | MarkdownString;
    iconPath?: IconPath;

    constructor(
        name: string,
        uri: Uri,
        options?: { description?: string; tooltip?: string | MarkdownString; iconPath?: IconPath },
    ) {
        this.name = name;
        this.uri = uri;
        this.description = options?.description ?? uri.fsPath;
        this.tooltip = options?.tooltip ?? uri.fsPath;
        this.iconPath = options?.iconPath;
    }
}

export interface ProjectCreators extends Disposable {
    registerPythonProjectCreator(creator: PythonProjectCreator): Disposable;
    getProjectCreators(): PythonProjectCreator[];
}
