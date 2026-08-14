import { ConfigurationTarget, Disposable, Event, EventEmitter, Uri, workspace } from 'vscode';
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
import { INLINE_SCRIPT_MANAGER_ID, SYSTEM_MANAGER_ID } from '../common/constants';
import {
    EnvironmentManagerAlreadyRegisteredError,
    PackageManagerAlreadyRegisteredError,
} from '../common/errors/AlreadyRegisteredError';
import { traceError, traceVerbose } from '../common/logging';
import { StopWatch } from '../common/stopWatch';
import { EventNames } from '../common/telemetry/constants';
import { sendTelemetryEvent } from '../common/telemetry/sender';
import { getCallingExtension } from '../common/utils/frameUtils';
import { normalizePath } from '../common/utils/pathUtils';
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
import {
    EditAllManagerSettings,
    getDefaultEnvManagerSetting,
    getDefaultPkgManagerSetting,
    getProjectEnvironmentManagerSetting,
    setAllManagerSettings,
} from './settings/settingHelpers';

function generateId(name: string, extensionId?: string): string {
    const newName = name.toLowerCase().replace(/[^a-zA-Z0-9-_]/g, '_');
    if (name !== newName) {
        traceVerbose(`Environment manager name "${name}"  was normalized to "${newName}"`);
    }
    return `${getCallingExtension(extensionId)}:${newName}`;
}

export class PythonEnvironmentManagers implements EnvironmentManagers {
    private _environmentManagers: Map<string, InternalEnvironmentManager> = new Map();
    private _packageManagers: Map<string, InternalPackageManager> = new Map();

    /**
     * The last environment announced as "active" for each scope.
     * Keyed by project URI string or 'global'.
     *
     * Used for: (1) change detection before firing onDidChangeActiveEnvironment,
     *           (2) fallback manager routing when no explicit setting exists.
     *
     * Only mutated by setEnvironment() / setEnvironments() / refreshEnvironment().
     */
    private readonly _activeSelection = new Map<string, PythonEnvironment | undefined>();
    private readonly _selectionRevisions = new Map<string, number>();
    private readonly _selectionOperationCounters = new Map<string, number>();

    private _onDidChangeEnvironmentManager = new EventEmitter<DidChangeEnvironmentManagerEventArgs>();
    private _onDidChangePackageManager = new EventEmitter<DidChangePackageManagerEventArgs>();
    private _onDidChangeEnvironments = new EventEmitter<InternalDidChangeEnvironmentsEventArgs>();

    /** Fires when ANY manager reports a selection change, regardless of whether that manager is selected. */
    private _onDidChangeManagerEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();

    /** Fires when the active (selected) environment for a scope actually changes. */
    private _onDidChangeActiveEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    private _onDidChangePackages = new EventEmitter<InternalDidChangePackagesEventArgs>();

    public onDidChangeEnvironmentManager: Event<DidChangeEnvironmentManagerEventArgs> =
        this._onDidChangeEnvironmentManager.event;
    public onDidChangePackageManager: Event<DidChangePackageManagerEventArgs> = this._onDidChangePackageManager.event;
    public onDidChangeEnvironments: Event<InternalDidChangeEnvironmentsEventArgs> = this._onDidChangeEnvironments.event;

    /** Fires when any registered manager reports a change — even if that manager is not the selected one. */
    public onDidChangeManagerEnvironment: Event<DidChangeEnvironmentEventArgs> =
        this._onDidChangeManagerEnvironment.event;
    public onDidChangePackages: Event<InternalDidChangePackagesEventArgs> = this._onDidChangePackages.event;

    /** Fires only when the *selected* manager's environment for a scope actually changes. */
    public onDidChangeActiveEnvironment: Event<DidChangeEnvironmentEventArgs> =
        this._onDidChangeActiveEnvironment.event;

    constructor(private readonly pm: PythonProjectManager) {}

    public registerEnvironmentManager(manager: EnvironmentManager, options?: { extensionId?: string }): Disposable {
        const registrationStopWatch = new StopWatch();
        const managerId = generateId(manager.name, options?.extensionId);
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
                if (this.isSameEnvironment(e.old, e.new)) {
                    return;
                }

                setImmediate(() => this._onDidChangeManagerEnvironment.fire(e));
            }),
        );

        this._environmentManagers.set(managerId, mgr);
        this._onDidChangeEnvironmentManager.fire({ kind: 'registered', manager: mgr });

        if (!managerId.toLowerCase().startsWith('undefined_publisher.')) {
            sendTelemetryEvent(EventNames.ENVIRONMENT_MANAGER_REGISTERED, registrationStopWatch.elapsedTime, {
                managerId,
            });
        }

        return new Disposable(() => {
            this._environmentManagers.delete(managerId);
            disposables.forEach((d) => d.dispose());
            setImmediate(() => this._onDidChangeEnvironmentManager.fire({ kind: 'unregistered', manager: mgr }));
        });
    }

    public registerPackageManager(manager: PackageManager, options?: { extensionId?: string }): Disposable {
        const managerId = generateId(manager.name, options?.extensionId);
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

        if (!managerId.toLowerCase().startsWith('undefined_publisher.')) {
            sendTelemetryEvent(EventNames.PACKAGE_MANAGER_REGISTERED, undefined, {
                managerId,
            });
        }

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
        this._onDidChangeManagerEnvironment.dispose();
        this._onDidChangeActiveEnvironment.dispose();
        this._onDidChangePackages.dispose();
    }

    /**
     * Returns the environment manager for the given context.
     *
     * Priority:
     * 1. Use an exact per-script project setting.
     * 2. Use a cached per-script inline selection.
     * 3. Use the containing project or default setting.
     * 4. Fall back to the cached project/global environment's manager.
     * 5. If context is a string or PythonEnvironment, return its manager directly.
     */
    public getEnvironmentManager(context: EnvironmentManagerScope): InternalEnvironmentManager | undefined {
        if (this._environmentManagers.size === 0) {
            traceError('No environment managers registered');
            return undefined;
        }

        if (context === undefined || context instanceof Uri) {
            const project = context ? this.pm.get(context) : undefined;
            if (
                context instanceof Uri &&
                project &&
                normalizePath(project.uri.fsPath) === normalizePath(context.fsPath)
            ) {
                const exactManagerId = getProjectEnvironmentManagerSetting(this.pm, context);
                const exactManager = exactManagerId
                    ? this._environmentManagers.get(exactManagerId)
                    : undefined;
                if (exactManager) {
                    return exactManager;
                }
            }

            if (context instanceof Uri) {
                const inlineEnv = this._activeSelection.get(this.getInlineScriptSelectionKey(context));
                if (inlineEnv?.envId.managerId === INLINE_SCRIPT_MANAGER_ID) {
                    const inlineManager = this._environmentManagers.get(INLINE_SCRIPT_MANAGER_ID);
                    if (inlineManager) {
                        return inlineManager;
                    }
                }
            }

            const defaultEnvManagerId = getDefaultEnvManagerSetting(this.pm, context);
            if (defaultEnvManagerId !== undefined) {
                const settingsManager = this._environmentManagers.get(defaultEnvManagerId);
                if (settingsManager) {
                    return settingsManager;
                }
            }

            const cachedEnv = this._activeSelection.get(project ? project.uri.toString() : 'global');
            if (cachedEnv) {
                const cachedManager = this._environmentManagers.get(cachedEnv.envId.managerId);
                if (cachedManager) {
                    return cachedManager;
                }
            }

            return undefined;
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

    /**
     * Sets the environment for a single scope, scope of undefined checks 'global'.
     * If given an array of scopes, delegates to setEnvironments for batch setting.
     *
     * @param scope - The scope to set the environment for
     * @param environment - The environment to set (optional)
     * @param shouldPersistSettings - Whether to persist to settings.json (default: true).
     *   Pass `false` when setting environments during initial selection/auto-discovery
     *   to avoid writing to settings.json.
     */
    public async setEnvironment(
        scope: SetEnvironmentScope,
        environment?: PythonEnvironment,
        shouldPersistSettings: boolean = true,
    ): Promise<void> {
        if (Array.isArray(scope)) {
            return this.setEnvironments(scope, environment, shouldPersistSettings);
        }

        const customScope = environment ? environment : scope;
        const manager = this.getEnvironmentManager(customScope);
        if (!manager) {
            traceError(
                `No environment manager found for scope: ${
                    customScope instanceof Uri ? customScope.fsPath : customScope?.environmentPath?.fsPath
                }`,
            );

            traceError(this.managers.map((m) => m.id).join(', '));
            return;
        }
        const project = scope ? this.pm.get(scope) : undefined;
        const key = this.getActiveSelectionKey(scope, manager, project);
        const operation = this.beginSelectionOperation(key);
        const inlineClearOperation =
            scope instanceof Uri && manager.id !== INLINE_SCRIPT_MANAGER_ID
                ? this.beginSelectionOperation(this.getInlineScriptSelectionKey(scope))
                : undefined;
        await manager.set(scope, environment);

        // Only persist to settings when explicitly requested
        if (shouldPersistSettings && scope) {
            const packageManager = this.getPackageManager(environment);
            const canPersistSettings =
                project &&
                packageManager &&
                this.canPersistManagerSettingForScope(scope, manager, project);
            if (canPersistSettings) {
                await setAllManagerSettings([
                    {
                        project,
                        envManager: manager.id,
                        packageManager: packageManager.id,
                    },
                ]);
            }
            traceVerbose(
                `[setEnvironment] scope=${scope instanceof Uri ? scope.fsPath : scope}, ` +
                    `env=${environment?.envId?.id ?? 'undefined'}, manager=${manager.id}, ` +
                    `project=${project?.uri?.toString() ?? 'none'}, ` +
                    `packageManager=${packageManager?.id ?? 'UNDEFINED'}, ` +
                    `settingsPersisted=${!!canPersistSettings}`,
            );
        }

        if (scope instanceof Uri) {
            this.clearInlineActiveSelection(scope, manager, inlineClearOperation);
        }
        if (!this.commitSelectionOperation(key, operation)) {
            return;
        }
        const oldEnv = this._activeSelection.get(key);
        if (!this.isSameEnvironment(oldEnv, environment)) {
            this._activeSelection.set(key, environment);
            await new Promise<void>((resolve, reject) => {
                setImmediate(() => {
                    try {
                        this._onDidChangeActiveEnvironment.fire({
                            uri: this.getActiveSelectionUri(scope, manager, project),
                            new: environment,
                            old: oldEnv,
                        });
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });
        }
    }

    /**
     * Sets the given environment for the specified project URIs or globally.
     * If a list of URIs is provided, sets the environment for each project; if 'global', sets it as the global environment.
     *
     * @param scope - Array of URIs or 'global'
     * @param environment - The environment to set (optional)
     * @param shouldPersistSettings - Whether to persist to settings.json (default: true).
     *   Pass `false` when setting environments during initial selection/auto-discovery
     *   to avoid writing to settings.json.
     */
    public async setEnvironments(
        scope: Uri[] | string,
        environment?: PythonEnvironment,
        shouldPersistSettings: boolean = true,
    ): Promise<void> {
        if (environment) {
            const manager = this.managers.find((m) => m.id === environment.envId.managerId);
            if (!manager) {
                traceError(
                    `No environment manager found for [${environment.envId.managerId}]: ${
                        environment.environmentPath ? environment.environmentPath.fsPath : ''
                    }`,
                );
                traceError(`Available managers: ${this.managers.map((m) => m.id).join(', ')}`);
                return;
            }

            const settings: EditAllManagerSettings[] = [];
            const events: DidChangeEnvironmentEventArgs[] = [];
            if (Array.isArray(scope) && scope.every((s) => s instanceof Uri)) {
                const selections = scope.map((uri) => this.beginPendingSelection(uri, manager));
                await manager.set(scope, environment);
                selections.forEach((selection) => {
                    const m = this.getEnvironmentManager(selection.scope);
                    // Always add settings when persisting, OR when manager differs
                    if (
                        (shouldPersistSettings || manager.id !== m?.id) &&
                        this.canPersistManagerSettingForScope(selection.scope, manager, selection.project)
                    ) {
                        settings.push({
                            project: selection.project,
                            envManager: manager.id,
                            packageManager: manager.preferredPackageManagerId,
                        });
                    }
                });
                if (shouldPersistSettings) {
                    await setAllManagerSettings(settings);
                }
                selections.forEach((selection) => {
                    this.clearInlineActiveSelection(selection.scope, manager, selection.inlineClearOperation);
                    if (!this.commitSelectionOperation(selection.key, selection.operation)) {
                        return;
                    }
                    const oldEnv = this._activeSelection.get(selection.key);
                    if (!this.isSameEnvironment(oldEnv, environment)) {
                        this._activeSelection.set(selection.key, environment);
                        events.push({
                            uri: this.getActiveSelectionUri(selection.scope, manager, selection.project),
                            new: environment,
                            old: oldEnv,
                        });
                    }
                });
            } else if (typeof scope === 'string' && scope === 'global') {
                const m = this.getEnvironmentManager(undefined);
                const operation = this.beginSelectionOperation('global');
                await manager.set(undefined, environment);
                // Always add settings when persisting, OR when manager differs
                if (shouldPersistSettings || manager.id !== m?.id) {
                    settings.push({
                        project: undefined,
                        envManager: manager.id,
                        packageManager: manager.preferredPackageManagerId,
                    });
                }

                if (shouldPersistSettings) {
                    await setAllManagerSettings(settings);
                }
                if (this.commitSelectionOperation('global', operation)) {
                    const oldEnv = this._activeSelection.get('global');
                    if (!this.isSameEnvironment(oldEnv, environment)) {
                        this._activeSelection.set('global', environment);
                        events.push({ uri: undefined, new: environment, old: oldEnv });
                    }
                }
            }
            if (events.length > 0) {
                await new Promise<void>((resolve, reject) => {
                    setImmediate(() => {
                        try {
                            events.forEach((e) => this._onDidChangeActiveEnvironment.fire(e));
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    });
                });
            }
        } else {
            const events: DidChangeEnvironmentEventArgs[] = [];
            if (Array.isArray(scope) && scope.every((s) => s instanceof Uri)) {
                const groupedScopes = new Map<InternalEnvironmentManager, Uri[]>();
                scope.forEach((uri) => {
                    const manager = this.getEnvironmentManager(uri);
                    if (manager) {
                        groupedScopes.set(manager, [...(groupedScopes.get(manager) ?? []), uri]);
                    }
                });
                for (const [manager, uris] of groupedScopes) {
                    const selections = uris.map((uri) => this.beginPendingSelection(uri, manager));
                    await manager.set(uris);
                    await Promise.all(
                        selections.map(async (selection) => {
                            const newEnv = await manager.get(selection.scope);
                            if (!this.commitSelectionOperation(selection.key, selection.operation)) {
                                return;
                            }
                            const oldEnv = this._activeSelection.get(selection.key);
                            if (!this.isSameEnvironment(oldEnv, newEnv)) {
                                this._activeSelection.set(selection.key, newEnv);
                                events.push({
                                    uri: this.getActiveSelectionUri(selection.scope, manager, selection.project),
                                    new: newEnv,
                                    old: oldEnv,
                                });
                            }
                        }),
                    );
                }
            } else if (typeof scope === 'string' && scope === 'global') {
                const manager = this.getEnvironmentManager(undefined);
                if (manager) {
                    const operation = this.beginSelectionOperation('global');
                    await manager.set(undefined);
                    const newEnv = await manager.get(undefined);
                    if (this.commitSelectionOperation('global', operation)) {
                        const oldEnv = this._activeSelection.get('global');
                        if (!this.isSameEnvironment(oldEnv, newEnv)) {
                            this._activeSelection.set('global', newEnv);
                            events.push({ uri: undefined, new: newEnv, old: oldEnv });
                        }
                    }
                }
            }
            if (events.length > 0) {
                await new Promise<void>((resolve, reject) => {
                    setImmediate(() => {
                        try {
                            events.forEach((e) => this._onDidChangeActiveEnvironment.fire(e));
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    });
                });
            }
        }
    }

    /**
     * Sets the environment for the given scopes, but only if the scope is not already set (i.e., is global or undefined).
     * Existing environments for a scope are not overwritten.
     *
     */
    public async setEnvironmentsIfUnset(scope: Uri[] | string, environment?: PythonEnvironment): Promise<void> {
        if (!environment) {
            return;
        }
        if (typeof scope === 'string' && scope === 'global') {
            const current = await this.getEnvironment(undefined);
            if (!current) {
                await this.setEnvironments('global', environment, true);
            }
        } else if (Array.isArray(scope)) {
            const urisToSet: Uri[] = [];
            for (const uri of scope) {
                const current = await this.getEnvironment(uri);
                if (!current || current.envId.managerId === SYSTEM_MANAGER_ID) {
                    // If the current environment is not set or is the system environment, set the new environment.
                    urisToSet.push(uri);
                }
            }
            if (urisToSet.length > 0) {
                await this.setEnvironments(urisToSet, environment, true);
            }
        }
    }

    /**
     * Gets the current Python environment for the given scope URI or undefined for 'global'.
     *
     * This is a pure read: it queries the environment manager but does NOT update the
     * internal selection cache or fire change events. Selection state is only mutated
     * through setEnvironment() / setEnvironments() / refreshEnvironment().
     *
     * @param scope The scope to get the environment.
     * @returns The current PythonEnvironment for the scope, or undefined if none is set.
     */
    async getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const manager = this.getEnvironmentManager(scope);
        if (!manager) {
            traceVerbose(
                `[getEnvironment] No manager found for scope=${scope instanceof Uri ? scope.fsPath : scope}, ` +
                    `settingsManagerId=${getDefaultEnvManagerSetting(this.pm, scope instanceof Uri ? scope : undefined)}`,
            );
            return undefined;
        }

        return manager.get(scope);
    }

    /**
     * Refreshes the cached environment for the given scope by querying the selected manager.
     * If the manager's current environment differs from the cache, updates the cache and
     * fires onDidChangeActiveEnvironment. Use this when a manager signals that its
     * selection has changed (e.g., via onDidChangeManagerEnvironment).
     *
     * Unlike getEnvironment(), this IS a mutation — it updates internal state.
     * Unlike setEnvironment(), it does NOT call manager.set() or persist to settings.
     */
    async refreshEnvironment(scope: GetEnvironmentScope): Promise<void> {
        const manager = this.getEnvironmentManager(scope);
        if (!manager) {
            return;
        }

        const project = scope ? this.pm.get(scope) : undefined;
        const key = this.getActiveSelectionKey(scope, manager, project);
        const operation = this.beginSelectionOperation(key);
        const newEnv = await manager.get(scope);
        if (this.getEnvironmentManager(scope) !== manager) {
            return;
        }

        const oldEnv = this._activeSelection.get(key);
        if (this.isSameEnvironment(oldEnv, newEnv) || !this.commitSelectionOperation(key, operation)) {
            return;
        }
        this._activeSelection.set(key, newEnv);
        setImmediate(() =>
            this._onDidChangeActiveEnvironment.fire({
                uri: this.getActiveSelectionUri(scope, manager, project),
                new: newEnv,
                old: oldEnv,
            }),
        );
    }

    getLastKnownEnvironment(scope: GetEnvironmentScope): PythonEnvironment | undefined {
        const project = scope ? this.pm.get(scope) : undefined;
        const manager = this.getEnvironmentManager(scope);
        const key = this.getActiveSelectionKey(scope, manager, project);
        return this._activeSelection.get(key);
    }

    private getActiveSelectionKey(
        scope: GetEnvironmentScope,
        manager: InternalEnvironmentManager | undefined,
        project: PythonProject | undefined,
    ): string {
        return scope instanceof Uri && manager?.id === INLINE_SCRIPT_MANAGER_ID
            ? this.getInlineScriptSelectionKey(scope)
            : project
              ? project.uri.toString()
              : 'global';
    }

    private getActiveSelectionUri(
        scope: GetEnvironmentScope,
        manager: InternalEnvironmentManager,
        project: PythonProject | undefined,
    ): Uri | undefined {
        return scope instanceof Uri && manager.id === INLINE_SCRIPT_MANAGER_ID ? scope : project?.uri;
    }

    private getInlineScriptSelectionKey(scope: Uri): string {
        return `inline-script:${normalizePath(scope.fsPath)}`;
    }

    private beginPendingSelection(scope: Uri, manager: InternalEnvironmentManager): PendingEnvironmentSelection {
        const project = this.pm.get(scope);
        const key = this.getActiveSelectionKey(scope, manager, project);
        return {
            scope,
            project,
            key,
            operation: this.beginSelectionOperation(key),
            inlineClearOperation:
                manager.id === INLINE_SCRIPT_MANAGER_ID
                    ? undefined
                    : this.beginSelectionOperation(this.getInlineScriptSelectionKey(scope)),
        };
    }

    private clearInlineActiveSelection(
        scope: Uri,
        manager: InternalEnvironmentManager,
        operation: number | undefined,
    ): void {
        if (manager.id === INLINE_SCRIPT_MANAGER_ID || operation === undefined) {
            return;
        }
        const key = this.getInlineScriptSelectionKey(scope);
        if (this.commitSelectionOperation(key, operation)) {
            this._activeSelection.delete(key);
        }
    }

    private canPersistManagerSettingForScope(
        scope: Uri,
        manager: InternalEnvironmentManager,
        project: PythonProject | undefined,
    ): boolean {
        // Inline associations are per file; never promote one to its containing project's manager setting.
        return (
            manager.id !== INLINE_SCRIPT_MANAGER_ID ||
            (!!project && normalizePath(project.uri.fsPath) === normalizePath(scope.fsPath))
        );
    }

    private beginSelectionOperation(key: string): number {
        const operation = (this._selectionOperationCounters.get(key) ?? 0) + 1;
        this._selectionOperationCounters.set(key, operation);
        return operation;
    }

    private commitSelectionOperation(key: string, operation: number): boolean {
        if ((this._selectionRevisions.get(key) ?? 0) > operation) {
            return false;
        }
        this._selectionRevisions.set(key, operation);
        return true;
    }

    private isSameEnvironment(
        first: PythonEnvironment | undefined,
        second: PythonEnvironment | undefined,
    ): boolean {
        if (first === second) {
            return true;
        }
        if (!first || !second || first.envId.managerId !== second.envId.managerId) {
            return false;
        }
        return first.envId.managerId === INLINE_SCRIPT_MANAGER_ID
            ? normalizePath(first.environmentPath.fsPath) === normalizePath(second.environmentPath.fsPath)
            : first.envId.id === second.envId.id;
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

interface PendingEnvironmentSelection {
    readonly scope: Uri;
    readonly project: PythonProject | undefined;
    readonly key: string;
    readonly operation: number;
    readonly inlineClearOperation: number | undefined;
}
