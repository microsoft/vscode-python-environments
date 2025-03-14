import { Uri, Disposable, Event, EventEmitter, Terminal, TaskExecution } from 'vscode';
import {
    PythonEnvironmentApi,
    PythonEnvironment,
    EnvironmentManager,
    PackageManager,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    DidChangePythonProjectsEventArgs,
    GetEnvironmentsScope,
    Package,
    PythonEnvironmentInfo,
    PythonProject,
    RefreshEnvironmentsScope,
    DidChangePackagesEventArgs,
    PythonEnvironmentId,
    CreateEnvironmentScope,
    SetEnvironmentScope,
    GetEnvironmentScope,
    PackageInfo,
    PackageId,
    PythonProjectCreator,
    ResolveEnvironmentContext,
    PackageInstallOptions,
    PythonProcess,
    PythonTaskExecutionOptions,
    PythonTerminalExecutionOptions,
    PythonBackgroundRunOptions,
    PythonTerminalCreateOptions,
    DidChangeEnvironmentVariablesEventArgs,
} from '../api';
import {
    EnvironmentManagers,
    InternalEnvironmentManager,
    ProjectCreators,
    PythonEnvironmentImpl,
    PythonPackageImpl,
    PythonProjectManager,
} from '../internal.api';
import { createDeferred } from '../common/utils/deferred';
import { traceInfo } from '../common/logging';
import { pickEnvironmentManager } from '../common/pickers/managers';
import { handlePythonPath } from '../common/utils/pythonPath';
import { TerminalManager } from './terminal/terminalManager';
import { runAsTask } from './execution/runAsTask';
import { runInTerminal } from './terminal/runInTerminal';
import { runInBackground } from './execution/runInBackground';
import { EnvVarManager } from './execution/envVariableManager';
import { checkPackageManagementPermissions, PackageManagerPermissions } from './permissions/packageManagerPermissions';

class PythonEnvironmentApiImpl implements PythonEnvironmentApi {
    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    private readonly _onDidChangePythonProjects = new EventEmitter<DidChangePythonProjectsEventArgs>();
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    private readonly _onDidChangeEnvironmentVariables = new EventEmitter<DidChangeEnvironmentVariablesEventArgs>();

    constructor(
        private readonly envManagers: EnvironmentManagers,
        private readonly projectManager: PythonProjectManager,
        private readonly projectCreators: ProjectCreators,
        private readonly terminalManager: TerminalManager,
        private readonly envVarManager: EnvVarManager,
        private readonly pkgPerm: PackageManagerPermissions,
        private readonly disposables: Disposable[] = [],
    ) {
        this.disposables.push(
            this._onDidChangeEnvironment,
            this._onDidChangeEnvironments,
            this._onDidChangePythonProjects,
            this._onDidChangePackages,
            this._onDidChangeEnvironmentVariables,
            this.envManagers.onDidChangeEnvironmentFiltered((e) => {
                this._onDidChangeEnvironment.fire(e);
                const location = e.uri?.fsPath ?? 'global';
                traceInfo(
                    `Python API: Changed environment from ${e.old?.displayName} to ${e.new?.displayName} for: ${location}`,
                );
            }),
            this.envVarManager.onDidChangeEnvironmentVariables((e) => this._onDidChangeEnvironmentVariables.fire(e)),
        );
    }

    registerEnvironmentManager(manager: EnvironmentManager): Disposable {
        const disposables: Disposable[] = [];
        disposables.push(this.envManagers.registerEnvironmentManager(manager));
        if (manager.onDidChangeEnvironments) {
            disposables.push(manager.onDidChangeEnvironments((e) => this._onDidChangeEnvironments.fire(e)));
        }
        if (manager.onDidChangeEnvironment) {
            disposables.push(
                manager.onDidChangeEnvironment((e) => {
                    setImmediate(async () => {
                        // This will ensure that we use the right manager and only trigger the event
                        // if the user selected manager decided to change the environment.
                        // This ensures that if a unselected manager changes environment and raises events
                        // we don't trigger the Python API event which can cause issues with the consumers.
                        // This will trigger onDidChangeEnvironmentFiltered event in envManagers, which the Python
                        // API listens to, and re-triggers the onDidChangeEnvironment event.
                        await this.envManagers.getEnvironment(e.uri);
                    });
                }),
            );
        }
        return new Disposable(() => disposables.forEach((d) => d.dispose()));
    }

    createPythonEnvironmentItem(info: PythonEnvironmentInfo, manager: EnvironmentManager): PythonEnvironment {
        const mgr = this.envManagers.managers.find((m) => m.equals(manager));
        if (!mgr) {
            throw new Error('Environment manager not found');
        }
        const randomStr = Math.random().toString(36).substring(2);
        const envId: PythonEnvironmentId = {
            managerId: mgr.id,
            id: `${info.name}-${randomStr}`,
        };
        return new PythonEnvironmentImpl(envId, info);
    }

    async createEnvironment(scope: CreateEnvironmentScope): Promise<PythonEnvironment | undefined> {
        if (scope === 'global' || (!Array.isArray(scope) && scope instanceof Uri)) {
            const manager = this.envManagers.getEnvironmentManager(scope === 'global' ? undefined : scope);
            if (!manager) {
                throw new Error('No environment manager found');
            }
            if (!manager.supportsCreate) {
                throw new Error(`Environment manager does not support creating environments: ${manager.id}`);
            }
            return manager.create(scope);
        } else if (Array.isArray(scope) && scope.length === 1 && scope[0] instanceof Uri) {
            return this.createEnvironment(scope[0]);
        } else if (Array.isArray(scope) && scope.length > 0 && scope.every((s) => s instanceof Uri)) {
            const managers: InternalEnvironmentManager[] = [];
            scope.forEach((s) => {
                const manager = this.envManagers.getEnvironmentManager(s);
                if (manager && !managers.includes(manager) && manager.supportsCreate) {
                    managers.push(manager);
                }
            });

            if (managers.length === 0) {
                throw new Error('No environment managers found');
            }

            const managerId = await pickEnvironmentManager(managers);
            if (!managerId) {
                throw new Error('No environment manager selected');
            }

            const manager = managers.find((m) => m.id === managerId);
            if (!manager) {
                throw new Error('No environment manager found');
            }

            const result = await manager.create(scope);
            return result;
        }
    }
    removeEnvironment(environment: PythonEnvironment): Promise<void> {
        const manager = this.envManagers.getEnvironmentManager(environment);
        if (!manager) {
            return Promise.reject(new Error('No environment manager found'));
        }
        return manager.remove(environment);
    }
    async refreshEnvironments(scope: RefreshEnvironmentsScope): Promise<void> {
        if (scope === undefined) {
            await Promise.all(this.envManagers.managers.map((manager) => manager.refresh(scope)));
            return Promise.resolve();
        }
        const manager = this.envManagers.getEnvironmentManager(scope);
        if (!manager) {
            return Promise.reject(new Error(`No environment manager found for: ${scope.fsPath}`));
        }
        return manager.refresh(scope);
    }
    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        if (scope === 'all' || scope === 'global') {
            const promises = this.envManagers.managers.map((manager) => manager.getEnvironments(scope));
            const items = await Promise.all(promises);
            return items.flat();
        }
        const manager = this.envManagers.getEnvironmentManager(scope);
        if (!manager) {
            return [];
        }

        const items = await manager.getEnvironments(scope);
        return items;
    }
    onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs> = this._onDidChangeEnvironments.event;
    setEnvironment(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        return this.envManagers.setEnvironment(scope, environment);
    }
    async getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return this.envManagers.getEnvironment(scope);
    }
    onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;
    async resolveEnvironment(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        const projects = this.projectManager.getProjects();
        const projectEnvManagers: InternalEnvironmentManager[] = [];
        projects.forEach((p) => {
            const manager = this.envManagers.getEnvironmentManager(p.uri);
            if (manager && !projectEnvManagers.includes(manager)) {
                projectEnvManagers.push(manager);
            }
        });

        return await handlePythonPath(context, this.envManagers.managers, projectEnvManagers);
    }

    registerPackageManager(manager: PackageManager): Disposable {
        const disposables: Disposable[] = [];
        disposables.push(this.envManagers.registerPackageManager(manager));
        if (manager.onDidChangePackages) {
            disposables.push(manager.onDidChangePackages((e) => this._onDidChangePackages.fire(e)));
        }
        return new Disposable(() => disposables.forEach((d) => d.dispose()));
    }
    async installPackages(
        context: PythonEnvironment,
        packages: string[],
        options: PackageInstallOptions,
    ): Promise<void> {
        const result = await checkPackageManagementPermissions(this.pkgPerm, 'install', packages);
        if (!result) {
            return Promise.reject(new Error('Permission denied'));
        }

        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.reject(new Error('No package manager found'));
        }
        return manager.install(context, packages, options);
    }
    async uninstallPackages(context: PythonEnvironment, packages: string[]): Promise<void> {
        const result = await checkPackageManagementPermissions(this.pkgPerm, 'uninstall', packages);
        if (!result) {
            return Promise.reject(new Error('Permission denied'));
        }

        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.reject(new Error('No package manager found'));
        }
        return manager.uninstall(context, packages);
    }
    refreshPackages(context: PythonEnvironment): Promise<void> {
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.reject(new Error('No package manager found'));
        }
        return manager.refresh(context);
    }
    getPackages(context: PythonEnvironment): Promise<Package[] | undefined> {
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.resolve(undefined);
        }
        return manager.getPackages(context);
    }
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;
    createPackageItem(info: PackageInfo, environment: PythonEnvironment, manager: PackageManager): Package {
        const mgr = this.envManagers.packageManagers.find((m) => m.equals(manager));
        if (!mgr) {
            throw new Error('Package manager not found');
        }
        const randomStr = Math.random().toString(36).substring(2);
        const pkg: PackageId = {
            managerId: mgr.id,
            environmentId: environment.envId.id,
            id: `${info.name}-${randomStr}`,
        };
        return new PythonPackageImpl(pkg, info);
    }

    addPythonProject(projects: PythonProject | PythonProject[]): void {
        this.projectManager.add(projects);
    }
    removePythonProject(pyWorkspace: PythonProject): void {
        this.projectManager.remove(pyWorkspace);
    }
    getPythonProjects(): readonly PythonProject[] {
        return this.projectManager.getProjects();
    }
    onDidChangePythonProjects: Event<DidChangePythonProjectsEventArgs> = this._onDidChangePythonProjects.event;
    getPythonProject(uri: Uri): PythonProject | undefined {
        return this.projectManager.get(uri);
    }
    registerPythonProjectCreator(creator: PythonProjectCreator): Disposable {
        return this.projectCreators.registerPythonProjectCreator(creator);
    }
    async createTerminal(environment: PythonEnvironment, options: PythonTerminalCreateOptions): Promise<Terminal> {
        return this.terminalManager.create(environment, options);
    }
    async runInTerminal(environment: PythonEnvironment, options: PythonTerminalExecutionOptions): Promise<Terminal> {
        const terminal = await this.terminalManager.getProjectTerminal(
            options.cwd instanceof Uri ? options.cwd : Uri.file(options.cwd),
            environment,
        );
        await runInTerminal(environment, terminal, options);
        return terminal;
    }
    async runInDedicatedTerminal(
        terminalKey: Uri | string,
        environment: PythonEnvironment,
        options: PythonTerminalExecutionOptions,
    ): Promise<Terminal> {
        const terminal = await this.terminalManager.getDedicatedTerminal(
            terminalKey,
            options.cwd instanceof Uri ? options.cwd : Uri.file(options.cwd),
            environment,
        );
        await runInTerminal(environment, terminal, options);
        return terminal;
    }
    runAsTask(environment: PythonEnvironment, options: PythonTaskExecutionOptions): Promise<TaskExecution> {
        return runAsTask(environment, options);
    }
    runInBackground(environment: PythonEnvironment, options: PythonBackgroundRunOptions): Promise<PythonProcess> {
        return runInBackground(environment, options);
    }

    onDidChangeEnvironmentVariables: Event<DidChangeEnvironmentVariablesEventArgs> =
        this._onDidChangeEnvironmentVariables.event;
    getEnvironmentVariables(
        uri: Uri,
        overrides?: ({ [key: string]: string | undefined } | Uri)[],
        baseEnvVar?: { [key: string]: string | undefined },
    ): Promise<{ [key: string]: string | undefined }> {
        return this.envVarManager.getEnvironmentVariables(uri, overrides, baseEnvVar);
    }
}

let _deferred = createDeferred<PythonEnvironmentApi>();
export function setPythonApi(
    envMgr: EnvironmentManagers,
    projectMgr: PythonProjectManager,
    projectCreators: ProjectCreators,
    terminalManager: TerminalManager,
    envVarManager: EnvVarManager,
    pkgPerm: PackageManagerPermissions,
) {
    _deferred.resolve(
        new PythonEnvironmentApiImpl(envMgr, projectMgr, projectCreators, terminalManager, envVarManager, pkgPerm),
    );
}

export function getPythonApi(): Promise<PythonEnvironmentApi> {
    return _deferred.promise;
}
