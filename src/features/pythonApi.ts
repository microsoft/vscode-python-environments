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
import { traceError } from '../common/logging';
import { showErrorMessage } from '../common/errors/utils';
import { pickEnvironmentManager } from '../common/pickers/managers';
import { handlePythonPath } from '../common/utils/pythonPath';
import { TerminalManager } from './terminal/terminalManager';
import { runAsTask } from './execution/runAsTask';
import { runInTerminal } from './terminal/runInTerminal';
import { runInBackground } from './execution/runInBackground';
import { setAllManagerSettings } from './settings/settingHelpers';

class PythonEnvironmentApiImpl implements PythonEnvironmentApi {
    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    private readonly _onDidChangePythonProjects = new EventEmitter<DidChangePythonProjectsEventArgs>();
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();

    private readonly _previousEnvironments = new Map<string, PythonEnvironment | undefined>();
    constructor(
        private readonly envManagers: EnvironmentManagers,
        private readonly projectManager: PythonProjectManager,
        private readonly projectCreators: ProjectCreators,
        private readonly terminalManager: TerminalManager,
    ) {}

    registerEnvironmentManager(manager: EnvironmentManager): Disposable {
        const disposables: Disposable[] = [];
        disposables.push(this.envManagers.registerEnvironmentManager(manager));
        if (manager.onDidChangeEnvironments) {
            disposables.push(manager.onDidChangeEnvironments((e) => this._onDidChangeEnvironments.fire(e)));
        }
        if (manager.onDidChangeEnvironment) {
            disposables.push(
                manager.onDidChangeEnvironment((e) => {
                    const mgr = this.envManagers.getEnvironmentManager(e.uri);
                    if (mgr?.equals(manager)) {
                        // Fire this event only if the manager set for current uri
                        // is the same as the manager that triggered environment change
                        setImmediate(() => {
                            this._onDidChangeEnvironment.fire(e);
                        });
                    }
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
                return Promise.reject(new Error('No environment manager found'));
            }
            return manager.create(scope);
        } else if (Array.isArray(scope) && scope.length === 1 && scope[0] instanceof Uri) {
            const manager = this.envManagers.getEnvironmentManager(scope[0]);
            if (!manager) {
                return Promise.reject(new Error('No environment manager found'));
            }
            return manager.create(scope);
        } else if (Array.isArray(scope) && scope.length > 0 && scope.every((s) => s instanceof Uri)) {
            const managers: InternalEnvironmentManager[] = [];
            scope.forEach((s) => {
                const manager = this.envManagers.getEnvironmentManager(s);
                if (manager && !managers.includes(manager)) {
                    managers.push(manager);
                }
            });

            if (managers.length === 0) {
                return Promise.reject(new Error('No environment managers found'));
            }
            const managerId = await pickEnvironmentManager(managers);
            if (!managerId) {
                return Promise.reject(new Error('No environment manager selected'));
            }
            const result = await managers.find((m) => m.id === managerId)?.create(scope);
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
    async setEnvironment(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        const manager = environment
            ? this.envManagers.getEnvironmentManager(environment.envId.managerId)
            : this.envManagers.getEnvironmentManager(scope);

        if (!manager) {
            throw new Error('No environment manager found');
        }
        await manager.set(scope, environment);
        if (scope) {
            const project = this.projectManager.get(scope);
            const packageManager = this.envManagers.getPackageManager(environment);
            if (project && packageManager) {
                await setAllManagerSettings([
                    {
                        project,
                        envManager: manager.id,
                        packageManager: packageManager.id,
                    },
                ]);
            }
        }

        const oldEnv = this._previousEnvironments.get(scope?.toString() ?? 'global');
        if (oldEnv?.envId.id !== environment?.envId.id) {
            this._previousEnvironments.set(scope?.toString() ?? 'global', environment);
            this._onDidChangeEnvironment.fire({ uri: scope, new: environment, old: oldEnv });
        }
    }
    async getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const manager = this.envManagers.getEnvironmentManager(scope);
        if (!manager) {
            return undefined;
        }
        const oldEnv = this._previousEnvironments.get(scope?.toString() ?? 'global');
        const newEnv = await manager.get(scope);
        if (oldEnv?.envId.id !== newEnv?.envId.id) {
            this._previousEnvironments.set(scope?.toString() ?? 'global', newEnv);
            this._onDidChangeEnvironment.fire({ uri: scope, new: newEnv, old: oldEnv });
        }
    }
    onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;
    async resolveEnvironment(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        if (context instanceof Uri) {
            const projects = this.projectManager.getProjects();
            const projectEnvManagers: InternalEnvironmentManager[] = [];
            projects.forEach((p) => {
                const manager = this.envManagers.getEnvironmentManager(p.uri);
                if (manager && !projectEnvManagers.includes(manager)) {
                    projectEnvManagers.push(manager);
                }
            });

            return await handlePythonPath(context, this.envManagers.managers, projectEnvManagers);
        } else if ('envId' in context) {
            const manager = this.envManagers.getEnvironmentManager(context);
            if (!manager) {
                const data = context instanceof Uri ? context.fsPath : context.environmentPath.fsPath;
                traceError(`No environment manager found: ${data}`);
                traceError(`Know environment managers: ${this.envManagers.managers.map((m) => m.name).join(', ')}`);
                showErrorMessage('No environment manager found');
                return undefined;
            }
            const env = await manager.resolve(context);
            if (env && !env.execInfo) {
                traceError(`Environment wasn't resolved correctly, missing execution info: ${env.name}`);
                traceError(`Environment: ${JSON.stringify(env)}`);
                traceError(`Resolved by: ${manager.id}`);
                showErrorMessage("Environment wasn't resolved correctly, missing execution info");
                return undefined;
            }

            return env;
        }
        return undefined;
    }

    registerPackageManager(manager: PackageManager): Disposable {
        const disposables: Disposable[] = [];
        disposables.push(this.envManagers.registerPackageManager(manager));
        if (manager.onDidChangePackages) {
            disposables.push(manager.onDidChangePackages((e) => this._onDidChangePackages.fire(e)));
        }
        return new Disposable(() => disposables.forEach((d) => d.dispose()));
    }
    installPackages(context: PythonEnvironment, packages: string[], options: PackageInstallOptions): Promise<void> {
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.reject(new Error('No package manager found'));
        }
        return manager.install(context, packages, options);
    }
    uninstallPackages(context: PythonEnvironment, packages: Package[] | string[]): Promise<void> {
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
    async createTerminal(
        environment: PythonEnvironment,
        cwd: string | Uri,
        envVars?: { [key: string]: string },
    ): Promise<Terminal> {
        return this.terminalManager.create(environment, cwd, envVars);
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
        terminalKey: Uri,
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
}

let _deferred = createDeferred<PythonEnvironmentApi>();
export function setPythonApi(
    envMgr: EnvironmentManagers,
    projectMgr: PythonProjectManager,
    projectCreators: ProjectCreators,
    terminalManager: TerminalManager,
) {
    _deferred.resolve(new PythonEnvironmentApiImpl(envMgr, projectMgr, projectCreators, terminalManager));
}

export function getPythonApi(): Promise<PythonEnvironmentApi> {
    return _deferred.promise;
}
