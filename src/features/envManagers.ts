import { Disposable, EventEmitter, Uri, workspace, ConfigurationTarget, Event } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    DidChangePackagesEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    PackageManager,
    PythonEnvironment,
    PythonProject,
    SetEnvironmentScope,
} from '../api';
import { traceError } from '../common/logging';
import {
    EditAllManagerSettings,
    getDefaultEnvManagerSetting,
    getDefaultPkgManagerSetting,
    setAllManagerSettings,
} from './settings/settingHelpers';
import {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagerScope,
    EnvironmentManagers,
    InternalDidChangeEnvironmentsEventArgs,
    InternalDidChangePackagesEventArgs,
    InternalEnvironmentManager,
    InternalPackageManager,
    PackageManagerScope,
    PythonProjectManager,
    PythonProjectSettings,
} from '../internal.api';
import { getCallingExtension } from '../common/extensions.apis';
import {
    EnvironmentManagerAlreadyRegisteredError,
    PackageManagerAlreadyRegisteredError,
} from '../common/errors/AlreadyRegisteredError';

function generateId(name: string): string {
    return `${getCallingExtension()}:${name}`;
}

export class PythonEnvironmentManagers implements EnvironmentManagers {
    private _environmentManagers: Map<string, InternalEnvironmentManager> = new Map();
    private _packageManagers: Map<string, InternalPackageManager> = new Map();
    private readonly _previousEnvironments = new Map<string, PythonEnvironment | undefined>();

    private _onDidChangeEnvironmentManager = new EventEmitter<DidChangeEnvironmentManagerEventArgs>();
    private _onDidChangePackageManager = new EventEmitter<DidChangePackageManagerEventArgs>();
    private _onDidChangeEnvironments = new EventEmitter<InternalDidChangeEnvironmentsEventArgs>();
    private _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    private _onDidChangeEnvironmentFiltered = new EventEmitter<DidChangeEnvironmentEventArgs>();
    private _onDidChangePackages = new EventEmitter<InternalDidChangePackagesEventArgs>();

    public onDidChangeEnvironmentManager: Event<DidChangeEnvironmentManagerEventArgs> =
        this._onDidChangeEnvironmentManager.event;
    public onDidChangePackageManager: Event<DidChangePackageManagerEventArgs> = this._onDidChangePackageManager.event;
    public onDidChangeEnvironments: Event<InternalDidChangeEnvironmentsEventArgs> = this._onDidChangeEnvironments.event;
    public onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;
    public onDidChangePackages: Event<InternalDidChangePackagesEventArgs> = this._onDidChangePackages.event;
    public onDidChangeEnvironmentFiltered: Event<DidChangeEnvironmentEventArgs> =
        this._onDidChangeEnvironmentFiltered.event;

    constructor(private readonly pm: PythonProjectManager) {}

    public registerEnvironmentManager(manager: EnvironmentManager): Disposable {
        const managerId = generateId(manager.name);
        if (this._environmentManagers.has(managerId)) {
            const ex = new EnvironmentManagerAlreadyRegisteredError(
                `Environment manager with id ${managerId} already registered`,
            );
            traceError(ex);
            throw ex;
        }

        const disposables: Disposable[] = [];
        const mgr = new InternalEnvironmentManager(managerId, manager);

        disposables.push(
            mgr.onDidChangeEnvironments((e: DidChangeEnvironmentsEventArgs) => {
                setImmediate(() =>
                    this._onDidChangeEnvironments.fire({
                        manager: mgr,
                        changes: e,
                    }),
                );
            }),
            mgr.onDidChangeEnvironment((e: DidChangeEnvironmentEventArgs) => {
                if (e.old?.envId.id === e.new?.envId.id) {
                    return;
                }

                setImmediate(() => this._onDidChangeEnvironment.fire(e));
            }),
        );

        this._environmentManagers.set(managerId, mgr);
        this._onDidChangeEnvironmentManager.fire({ kind: 'registered', manager: mgr });
        return new Disposable(() => {
            this._environmentManagers.delete(managerId);
            disposables.forEach((d) => d.dispose());
            setImmediate(() => this._onDidChangeEnvironmentManager.fire({ kind: 'unregistered', manager: mgr }));
        });
    }

    public registerPackageManager(manager: PackageManager): Disposable {
        const managerId = generateId(manager.name);
        if (this._packageManagers.has(managerId)) {
            const ex = new PackageManagerAlreadyRegisteredError(
                `Package manager with id ${managerId} already registered`,
            );
            traceError(ex);
            throw ex;
        }
        const disposables: Disposable[] = [];
        const mgr = new InternalPackageManager(managerId, manager);

        disposables.push(
            mgr.onDidChangePackages((e: DidChangePackagesEventArgs) => {
                setImmediate(() =>
                    this._onDidChangePackages.fire({
                        environment: e.environment,
                        manager: mgr,
                        changes: e.changes,
                    }),
                );
            }),
        );

        this._packageManagers.set(managerId, mgr);
        this._onDidChangePackageManager.fire({ kind: 'registered', manager: mgr });
        return new Disposable(() => {
            this._packageManagers.delete(managerId);
            disposables.forEach((d) => d.dispose());
            setImmediate(() => this._onDidChangePackageManager.fire({ kind: 'unregistered', manager: mgr }));
        });
    }

    public dispose() {
        this._environmentManagers.clear();
        this._packageManagers.clear();
        this._onDidChangeEnvironmentManager.dispose();
        this._onDidChangePackageManager.dispose();
        this._onDidChangeEnvironments.dispose();
        this._onDidChangePackages.dispose();
    }

    public getEnvironmentManager(context: EnvironmentManagerScope): InternalEnvironmentManager | undefined {
        if (this._environmentManagers.size === 0) {
            traceError('No environment managers registered');
            return undefined;
        }

        if (context === undefined || context instanceof Uri) {
            // get default environment manager from setting
            const defaultEnvManagerId = getDefaultEnvManagerSetting(this.pm, context);
            if (defaultEnvManagerId === undefined) {
                return undefined;
            }
            return this._environmentManagers.get(defaultEnvManagerId);
        }

        if (typeof context === 'string') {
            return this._environmentManagers.get(context);
        }

        return this._environmentManagers.get(context.envId.managerId);
    }

    public getPackageManager(context: PackageManagerScope): InternalPackageManager | undefined {
        if (this._packageManagers.size === 0) {
            traceError('No package managers registered');
            return undefined;
        }

        if (context === undefined || context instanceof Uri) {
            const defaultPkgManagerId = getDefaultPkgManagerSetting(this.pm, context);
            const defaultEnvManagerId = getDefaultEnvManagerSetting(this.pm, context);
            if (defaultPkgManagerId) {
                return this._packageManagers.get(defaultPkgManagerId);
            }

            if (defaultEnvManagerId) {
                const preferredPkgManagerId =
                    this._environmentManagers.get(defaultEnvManagerId)?.preferredPackageManagerId;
                if (preferredPkgManagerId) {
                    return this._packageManagers.get(preferredPkgManagerId);
                }
            }
            return undefined;
        }

        if (typeof context === 'string') {
            return this._packageManagers.get(context);
        }

        if ('pkgId' in context) {
            return this._packageManagers.get(context.pkgId.managerId);
        } else {
            const id = this._environmentManagers.get(context.envId.managerId)?.preferredPackageManagerId;
            if (id) {
                return this._packageManagers.get(id);
            }
        }

        return undefined;
    }

    public get managers(): InternalEnvironmentManager[] {
        return Array.from(this._environmentManagers.values());
    }
    public get packageManagers(): InternalPackageManager[] {
        return Array.from(this._packageManagers.values());
    }

    public setPythonProject(pw: PythonProject, manager: InternalEnvironmentManager): void {
        const config = workspace.getConfiguration('python-envs', pw.uri);
        const settings = config.get<PythonProjectSettings[]>('pythonProjects', []);
        settings.push({
            path: pw.uri.fsPath,
            envManager: manager.id,
            packageManager: 'preferred',
        });
        config.update('pythonProjects', settings, ConfigurationTarget.Workspace);
    }

    public async clearCache(scope: EnvironmentManagerScope): Promise<void> {
        if (scope === undefined) {
            await Promise.all(this.managers.map((m) => m.clearCache()));
            return;
        }

        const manager = this.getEnvironmentManager(scope);
        if (manager) {
            await manager.clearCache();
        }
    }

    public async setEnvironment(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        const customScope = environment ? environment : scope;
        const manager = this.getEnvironmentManager(customScope);
        if (!manager) {
            traceError(
                `No environment manager found for: ${
                    customScope instanceof Uri ? customScope.fsPath : customScope?.environmentPath?.fsPath
                }`,
            );
            return;
        }
        await manager.set(scope, environment);

        const project = scope ? this.pm.get(scope) : undefined;
        if (scope) {
            const packageManager = this.getPackageManager(environment);
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

        const oldEnv = this._previousEnvironments.get(project?.uri.toString() ?? 'global');
        if (oldEnv?.envId.id !== environment?.envId.id) {
            this._previousEnvironments.set(project?.uri.toString() ?? 'global', environment);
            setImmediate(() =>
                this._onDidChangeEnvironmentFiltered.fire({ uri: project?.uri, new: environment, old: oldEnv }),
            );
        }
    }

    public async setEnvironments(scope: Uri[], environment?: PythonEnvironment): Promise<void> {
        if (environment) {
            const manager = this.managers.find((m) => m.id === environment.envId.managerId);
            if (!manager) {
                traceError(
                    `No environment manager found for: ${
                        environment.environmentPath ? environment.environmentPath.fsPath : ''
                    }`,
                );
                return;
            }

            const promises: Promise<void>[] = [];
            const settings: EditAllManagerSettings[] = [];
            const events: DidChangeEnvironmentEventArgs[] = [];
            scope.forEach((uri) => {
                const m = this.getEnvironmentManager(uri);
                promises.push(manager.set(uri, environment));
                if (manager.id !== m?.id) {
                    settings.push({
                        project: this.pm.get(uri),
                        envManager: manager.id,
                        packageManager: manager.preferredPackageManagerId,
                    });
                }

                const project = this.pm.get(uri);
                const oldEnv = this._previousEnvironments.get(project?.uri.toString() ?? 'global');
                if (oldEnv?.envId.id !== environment?.envId.id) {
                    this._previousEnvironments.set(project?.uri.toString() ?? 'global', environment);
                    events.push({ uri: project?.uri, new: environment, old: oldEnv });
                }
            });
            await Promise.all(promises);
            await setAllManagerSettings(settings);
            setImmediate(() => events.forEach((e) => this._onDidChangeEnvironmentFiltered.fire(e)));
        } else {
            const promises: Promise<void>[] = [];
            const events: DidChangeEnvironmentEventArgs[] = [];
            scope.forEach((uri) => {
                const manager = this.getEnvironmentManager(uri);
                if (manager) {
                    const setAndAddEvent = async () => {
                        await manager.set(uri);

                        const project = this.pm.get(uri);

                        // Always get the new first, then compare with the old. This has minor impact on the ordering of
                        // events. But it ensures that we always get the latest environment at the time of this call.
                        const newEnv = await manager.get(uri);
                        const oldEnv = this._previousEnvironments.get(project?.uri.toString() ?? 'global');
                        if (oldEnv?.envId.id !== newEnv?.envId.id) {
                            this._previousEnvironments.set(project?.uri.toString() ?? 'global', newEnv);
                            events.push({ uri: project?.uri, new: newEnv, old: oldEnv });
                        }
                    };
                    promises.push(setAndAddEvent());
                }
            });
            await Promise.all(promises);
            setImmediate(() => events.forEach((e) => this._onDidChangeEnvironmentFiltered.fire(e)));
        }
    }

    async getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const manager = this.getEnvironmentManager(scope);
        if (!manager) {
            return undefined;
        }

        const project = scope ? this.pm.get(scope) : undefined;

        // Always get the new first, then compare with the old. This has minor impact on the ordering of
        // events. But it ensures that we always get the latest environment at the time of this call.
        const newEnv = await manager.get(scope);
        const oldEnv = this._previousEnvironments.get(project?.uri.toString() ?? 'global');
        if (oldEnv?.envId.id !== newEnv?.envId.id) {
            this._previousEnvironments.set(project?.uri.toString() ?? 'global', newEnv);
            setImmediate(() =>
                this._onDidChangeEnvironmentFiltered.fire({ uri: project?.uri, new: newEnv, old: oldEnv }),
            );
        }
        return newEnv;
    }

    getProjectEnvManagers(uris: Uri[]): InternalEnvironmentManager[] {
        const projectEnvManagers: InternalEnvironmentManager[] = [];
        uris.forEach((uri) => {
            const manager = this.getEnvironmentManager(uri);
            if (manager && !projectEnvManagers.includes(manager)) {
                projectEnvManagers.push(manager);
            }
        });
        return projectEnvManagers;
    }
}
