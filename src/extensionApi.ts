import { Disposable, Event, EventEmitter, l10n, TaskExecution, Terminal, Uri } from 'vscode';
import * as path from 'path';
import type { CapabilityContext, EnvironmentManagerCapability, PackageManagerCapability, Support } from './capabilities';
import { EnvironmentCapability, isKnownManagerCapability, PackageCapability } from './capabilities';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { EventNames } from './common/telemetry/constants';
import { sendTelemetryEvent } from './common/telemetry/sender';
import type {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    DidChangeEnvironmentVariablesEventArgs,
    DidChangePackagesEventArgs,
    DidChangePythonProjectsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    GetPackageAvailableVersionsOptions,
    GetPackagesOptions,
    Package,
    PackageId,
    PackageInfo,
    PackageManagementOptions,
    PackageManager,
    Pep440Version,
    PythonBackgroundRunOptions,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentId,
    PythonEnvironmentInfo,
    PythonProcess,
    PythonProject,
    PythonProjectCreator,
    PythonTaskExecutionOptions,
    PythonTerminalCreateOptions,
    PythonTerminalExecutionOptions,
    RefreshEnvironmentsScope,
    RemoveEnvironmentOptions,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from './types';
import { PackageVersionLookupNotSupportedError } from './publicErrors';
import { INLINE_SCRIPT_MANAGER_ID } from './common/constants';
import { traceError, traceInfo } from './common/logging';
import { pickEnvironmentManager } from './common/pickers/managers';
import { timeout } from './common/utils/asyncUtils';
import { createDeferred } from './common/utils/deferred';
import { checkUri, normalizePath } from './common/utils/pathUtils';
import { handlePythonPath } from './common/utils/pythonPath';
import type { EnvironmentManagers } from './features/envManagers';
import type { ProjectCreators } from './features/creators/projectCreators';
import type { PythonProjectManager } from './features/projectManager';
import type { InternalEnvironmentManager, InternalPackageManager } from './managers/common/registeredManagers';
import { PythonEnvironmentImpl, PythonPackageImpl } from './managers/common/models';
import { waitForAllEnvManagers, waitForEnvManager, waitForEnvManagerId } from './features/common/managerReady';
import { EnvVarManager } from './features/execution/envVariableManager';
import { runAsTask } from './features/execution/runAsTask';
import { runInBackground } from './features/execution/runInBackground';
import { runInTerminal } from './features/terminal/runInTerminal';
import { TerminalManager } from './features/terminal/terminalManager';
import { PythonToolsApiImpl } from './internal/pythonTools';
import type { PythonToolsApi } from './internal/pythonToolsApi';

// Maximum time getEnvironment will block before serving the last-known environment while a
// slow initial resolution/refresh continues in the background. Keeps consumers (e.g. Pylance's
// workspace/configuration handler) from hanging on the full environment enumeration at startup.
const GET_ENVIRONMENT_TIMEOUT_MS = 1000;
const GET_ENVIRONMENT_TIMED_OUT = Symbol('getEnvironmentTimedOut');
const CAPABILITY_TELEMETRY_VERSION_TIMEOUT_MS = 1000;

type ManagerCapabilityQuery =
    | {
          kind: 'environment';
          manager: InternalEnvironmentManager | undefined;
          managerId: string;
          capability: EnvironmentManagerCapability;
          context?: CapabilityContext;
      }
    | {
          kind: 'package';
          manager: InternalPackageManager | undefined;
          capability: PackageManagerCapability;
          context: CapabilityContext & { environment: PythonEnvironment };
      };

function logCapabilityQueryError(error: unknown): void {
    traceError('Failed to query manager capability:', error);
}

export class PythonEnvironmentApiImpl implements PythonEnvironmentApi {
    readonly __pythonTools: PythonToolsApi;
    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    private readonly _onDidChangePythonProjects = new EventEmitter<DidChangePythonProjectsEventArgs>();
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    private readonly _onDidChangeEnvironmentVariables = new EventEmitter<DidChangeEnvironmentVariablesEventArgs>();
    // Tracks the last-known project set so we can compute an added/removed delta
    // whenever the underlying project manager reports a change (fix for #1599).
    private previousProjects: readonly PythonProject[] = [];

    constructor(
        private readonly envManagers: EnvironmentManagers,
        private readonly projectManager: PythonProjectManager,
        private readonly projectCreators: ProjectCreators,
        private readonly terminalManager: TerminalManager,
        private readonly envVarManager: EnvVarManager,
        private readonly disposables: Disposable[] = [],
    ) {
        this.__pythonTools = new PythonToolsApiImpl(envManagers, projectManager);
        this.previousProjects = this.projectManager.getProjects();

        this.disposables.push(
            this._onDidChangeEnvironment,
            this._onDidChangeEnvironments,
            this._onDidChangePythonProjects,
            this._onDidChangePackages,
            this._onDidChangeEnvironmentVariables,
            this.envManagers.onDidChangePackageProviderPackages((e) => this._onDidChangePackages.fire(e)),
            this.envManagers.onDidChangeActiveEnvironment((e) => {
                this._onDidChangeEnvironment.fire(e);
                const location = e.uri?.fsPath ?? 'global';
                traceInfo(
                    `Python API: Changed environment from ${e.old?.displayName} to ${e.new?.displayName} for: ${location}`,
                );
            }),
            this.envVarManager.onDidChangeEnvironmentVariables((e) => this._onDidChangeEnvironmentVariables.fire(e)),
            this.projectManager.onDidChangeProjects(() => {
                const current = this.projectManager.getProjects();
                const currentByUri = new Map(current.map((p) => [p.uri.toString(), p] as const));
                const previousByUri = new Map(this.previousProjects.map((p) => [p.uri.toString(), p] as const));

                const added = [...currentByUri.entries()]
                    .filter(([uri]) => !previousByUri.has(uri))
                    .map(([, project]) => project);
                const removed = [...previousByUri.entries()]
                    .filter(([uri]) => !currentByUri.has(uri))
                    .map(([, project]) => project);

                this.previousProjects = current;
                if (added.length > 0 || removed.length > 0) {
                    traceInfo(`Python API: Projects changed. Added: ${added.length}, Removed: ${removed.length}`);
                    this._onDidChangePythonProjects.fire({ added, removed });
                }
            }),
        );
    }

    registerEnvironmentManager(manager: EnvironmentManager, options?: { extensionId?: string }): Disposable {
        const disposables: Disposable[] = [];
        disposables.push(this.envManagers.registerEnvironmentManager(manager, options));
        if (manager.onDidChangeEnvironments) {
            disposables.push(manager.onDidChangeEnvironments((e) => this._onDidChangeEnvironments.fire(e)));
        }
        if (manager.onDidChangeEnvironment) {
            disposables.push(
                manager.onDidChangeEnvironment((e) => {
                    setImmediate(() => {
                        // Refresh the central cache for this scope. This ensures that only the
                        // *selected* manager's changes propagate (refreshEnvironment checks
                        // getEnvironmentManager(scope) internally). It updates the cache and
                        // fires onDidChangeActiveEnvironment, which the Python API listens to.
                        this.envManagers
                            .refreshEnvironment(e.uri)
                            .catch((err) => traceError('Failed to refresh environment on change:', err));
                    });
                }),
            );
        }
        return new Disposable(() => disposables.forEach((d) => d.dispose()));
    }

    /**
     * Queries one registered environment provider without activation, waiting, or prompting.
     * @param managerId Exact registered environment manager ID.
     * @param capability Feature to query.
     * @param context Optional scope, environment, and project forwarded to the provider.
     */
    async getEnvironmentManagerCapability(
        managerId: string,
        capability: EnvironmentManagerCapability,
        context?: CapabilityContext,
    ): Promise<Support> {
        if (context?.environment && context.environment.envId.managerId !== managerId) {
            throw new Error(l10n.t('The environment does not belong to environment manager {0}.', managerId));
        }
        const manager = this.envManagers.getEnvironmentManager(managerId);
        return this.captureCapabilityQuery({
            kind: 'environment',
            manager,
            managerId,
            capability,
            context,
        });
    }

    /**
     * Queries the registered package provider routed for an environment or explicit project without activation or waiting.
     * @param environment Environment whose packages would be managed.
     * @param capability Feature to query.
     * @param project Optional project selecting its configured, project-bound provider.
     */
    async getPackageManagerCapability(
        environment: PythonEnvironment,
        capability: PackageManagerCapability,
        project?: PythonProject,
    ): Promise<Support> {
        const registeredProject = project && this.projectManager.getProjects().find(
            ({ uri }) => uri.scheme === project.uri.scheme && (
                uri.scheme === 'file'
                    ? normalizePath(path.resolve(uri.fsPath)) === normalizePath(path.resolve(project.uri.fsPath))
                    : uri.toString() === project.uri.toString()
            ),
        );
        let manager = !project || registeredProject
            ? this.envManagers.getPackageManager(registeredProject?.uri ?? environment)
            : undefined;
        // A project-aware root is not a usable substitute for a missing scoped instance.
        if (manager?.createForProject && !manager.project) {
            manager = undefined;
        }
        return this.captureCapabilityQuery({
            kind: 'package',
            manager,
            capability,
            context: { environment, project: registeredProject ?? project },
        });
    }

    private async captureCapabilityQuery(query: ManagerCapabilityQuery): Promise<Support> {
        const { manager, capability } = query;
        let outcome: 'supported' | 'unsupported' | 'unavailable' | 'error' = 'error';
        let isLegacy = false;
        try {
            if (!query.manager) {
                outcome = 'unavailable';
                return {
                    supported: false,
                    reason: query.kind === 'environment'
                        ? l10n.t('Environment manager {0} is unavailable.', query.managerId)
                        : l10n.t('No package manager is available for the environment and project context.'),
                };
            }
            const support = query.kind === 'environment'
                ? await query.manager.getCapability(query.capability, query.context)
                : await query.manager.getCapability(query.capability, query.context);
            outcome = support.supported ? 'supported' : 'unsupported';
            isLegacy = support.isLegacy === true;
            return support;
        } finally {
            void this.getManagerVersionForTelemetryWithTimeout(query, CAPABILITY_TELEMETRY_VERSION_TIMEOUT_MS)
                .then((managerVersion) => {
                    sendTelemetryEvent(EventNames.MANAGER_CAPABILITY_QUERY, undefined, {
                        managerId: manager?.id ?? 'none',
                        managerKind: query.kind,
                        managerVersion,
                        capability: isKnownManagerCapability(capability) ? capability : 'unknown',
                        outcome,
                        isLegacy,
                    });
                })
                .catch((error) => traceError('Failed to send manager capability query telemetry:', error));
        }
    }

    private async getManagerVersionForTelemetryWithTimeout(
        query: ManagerCapabilityQuery,
        timeoutMs: number,
    ): Promise<string> {
        if (!query.manager) {
            return 'unknown';
        }

        let versionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const version = await Promise.race([
                query.kind === 'package'
                    ? query.manager.getVersion(query.context.environment)
                    : query.manager.getVersion(),
                new Promise<never>((_, reject) => {
                    versionTimer = setTimeout(
                        () => reject(new Error('Manager version lookup timed out.')),
                        timeoutMs,
                    );
                }),
            ]);
            return version ? parsePep440Version(version.public)?.public ?? 'unknown' : 'unknown';
        } catch (error) {
            traceError(`Failed to retrieve manager version for capability telemetry: ${query.manager.id}`, error);
            return 'unknown';
        } finally {
            if (versionTimer !== undefined) {
                clearTimeout(versionTimer);
            }
        }
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

    async createEnvironment(
        scope: CreateEnvironmentScope,
        options: CreateEnvironmentOptions | undefined,
    ): Promise<PythonEnvironment | undefined> {
        if (scope === 'global' || (!Array.isArray(scope) && scope instanceof Uri)) {
            await waitForEnvManager(scope === 'global' ? undefined : [scope]);
            const manager = this.envManagers.getEnvironmentManager(scope === 'global' ? undefined : scope);
            if (!manager) {
                throw new Error('No environment manager found');
            }
            void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.Create, { scope })
                .catch(logCapabilityQueryError);
            if (!manager.supportsCreate) {
                throw new Error(`Environment manager does not support creating environments: ${manager.id}`);
            }
            return manager.create(scope, options);
        } else if (Array.isArray(scope) && scope.length === 1 && scope[0] instanceof Uri) {
            return this.createEnvironment(scope[0], options);
        } else if (Array.isArray(scope) && scope.length > 0 && scope.every((s) => s instanceof Uri)) {
            await waitForEnvManager(scope);
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

            void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.Create, { scope })
                .catch(logCapabilityQueryError);
            const result = await manager.create(scope, options);
            return result;
        }
    }
    async removeEnvironment(environment: PythonEnvironment, options?: RemoveEnvironmentOptions): Promise<void> {
        await waitForEnvManagerId([environment.envId.managerId]);
        const manager = this.envManagers.getEnvironmentManager(environment);
        if (!manager) {
            return Promise.reject(new Error('No environment manager found'));
        }
        void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.Remove, { environment })
            .catch(logCapabilityQueryError);
        return manager.remove(environment, options);
    }
    async refreshEnvironments(scope: RefreshEnvironmentsScope): Promise<void> {
        const currentScope = checkUri(scope) as RefreshEnvironmentsScope;

        if (currentScope === undefined) {
            await waitForAllEnvManagers();
            await Promise.all(this.envManagers.managers.map((manager) => {
                void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.List, { scope: currentScope })
                    .catch(logCapabilityQueryError);
                return manager.refresh(currentScope);
            }));
            return Promise.resolve();
        }

        await waitForEnvManager([currentScope]);
        const manager = this.envManagers.getEnvironmentManager(currentScope);
        if (!manager) {
            return Promise.reject(new Error(`No environment manager found for: ${currentScope.fsPath}`));
        }
        void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.List, { scope: currentScope })
            .catch(logCapabilityQueryError);
        return manager.refresh(currentScope);
    }
    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        const currentScope = checkUri(scope) as GetEnvironmentsScope;
        if (currentScope === 'all' || currentScope === 'global') {
            await waitForAllEnvManagers();
            const promises = this.envManagers.managers.map((manager) => {
                void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.List, { scope: currentScope })
                    .catch(logCapabilityQueryError);
                return manager.getEnvironments(currentScope);
            });
            const items = await Promise.all(promises);
            return items.flat();
        }

        await waitForEnvManager([currentScope]);
        const manager = this.envManagers.getEnvironmentManager(currentScope);
        if (!manager) {
            return [];
        }

        void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.List, { scope: currentScope })
            .catch(logCapabilityQueryError);
        const items = await manager.getEnvironments(currentScope);
        return items;
    }
    onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs> = this._onDidChangeEnvironments.event;
    async setEnvironment(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        const currentScope = checkUri(scope) as SetEnvironmentScope;
        await waitForEnvManager(
            currentScope ? (currentScope instanceof Uri ? [currentScope] : currentScope) : undefined,
        );
        if (Array.isArray(currentScope) && !environment) {
            const scopesByManager = new Map<InternalEnvironmentManager, Uri[]>();
            for (const uri of currentScope) {
                const manager = this.envManagers.getEnvironmentManager(uri);
                if (manager) {
                    scopesByManager.set(manager, [...(scopesByManager.get(manager) ?? []), uri]);
                }
            }
            for (const [manager, scopes] of scopesByManager) {
                void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.SetSelected, { scope: scopes })
                    .catch(logCapabilityQueryError);
            }
        } else {
            const manager = this.envManagers.getEnvironmentManager(
                environment ?? (currentScope instanceof Uri ? currentScope : undefined),
            );
            if (manager) {
                void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.SetSelected, {
                    scope: currentScope,
                    environment,
                }).catch(logCapabilityQueryError);
            }
        }
        return this.envManagers.setEnvironment(currentScope, environment);
    }
    async getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const currentScope = checkUri(scope) as GetEnvironmentScope;

        // Don't block callers (notably Pylance's workspace/configuration handler) on a potentially
        // slow initial environment resolution/refresh. Race the real resolution against a short
        // timeout; if it doesn't complete promptly, return the last-known environment for the scope.
        // The resolution continues in the background and consumers are notified of the real value
        // via onDidChangeEnvironment once it settles.
        const resolution = (async () => {
            await waitForEnvManager(currentScope ? [currentScope] : undefined);
            const manager = this.envManagers.getEnvironmentManager(currentScope);
            if (manager) {
                void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.GetSelected, { scope: currentScope })
                    .catch(logCapabilityQueryError);
            }
            return this.envManagers.getEnvironment(currentScope);
        })();

        const result = await Promise.race([
            resolution,
            timeout(GET_ENVIRONMENT_TIMEOUT_MS).then(() => GET_ENVIRONMENT_TIMED_OUT),
        ]);
        if (result !== GET_ENVIRONMENT_TIMED_OUT) {
            return result as PythonEnvironment | undefined;
        }

        // Keep the background resolution alive so the cache/last-known value gets populated and the
        // change event fires once it finishes.
        resolution.catch((ex) => traceError('Failed to resolve environment in background', ex));
        // Inline-script environments are reclaimed from a shared cache, and the manager withholds
        // one it cannot prove is still safe. Serving the last-known value here would hand back the
        // descriptor that decision just rejected, so only the timeout is skipped for them; every
        // other manager keeps the fast fallback.
        if (this.envManagers.getEnvironmentManager(currentScope)?.id === INLINE_SCRIPT_MANAGER_ID) {
            return resolution;
        }
        return this.envManagers.getLastKnownEnvironment(currentScope);
    }
    onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;
    async resolveEnvironment(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        await waitForAllEnvManagers();
        const projects = this.projectManager.getProjects();
        const projectEnvManagers: InternalEnvironmentManager[] = [];
        projects.forEach((p) => {
            const manager = this.envManagers.getEnvironmentManager(p.uri);
            if (manager && !projectEnvManagers.includes(manager)) {
                projectEnvManagers.push(manager);
            }
        });

        for (const manager of new Set([...projectEnvManagers, ...this.envManagers.managers])) {
            void this.getEnvironmentManagerCapability(manager.id, EnvironmentCapability.Resolve)
                .catch(logCapabilityQueryError);
        }
        return await handlePythonPath(context, this.envManagers.managers, projectEnvManagers);
    }

    registerPackageManager(manager: PackageManager, options?: { extensionId?: string }): Disposable {
        return this.envManagers.registerPackageManager(manager, options);
    }
    async managePackages(context: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        await waitForEnvManagerId([context.envId.managerId]);
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.reject(new Error('No package manager found'));
        }
        const hasInstall = !!options.install?.length;
        const hasUninstall = !!options.uninstall?.length;
        const interactive = !hasInstall && !hasUninstall;
        for (const [capability, requested] of [
            [options.upgrade ? PackageCapability.Upgrade : PackageCapability.Install, hasInstall || interactive],
            [PackageCapability.Uninstall, hasUninstall || interactive],
            [PackageCapability.Install, interactive && options.upgrade],
        ] as const) {
            if (requested) {
                void this.getPackageManagerCapability(context, capability, manager.project).catch(logCapabilityQueryError);
            }
        }
        return manager.manage(context, options);
    }
    async refreshPackages(context: PythonEnvironment): Promise<void> {
        await waitForEnvManagerId([context.envId.managerId]);
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.reject(new Error('No package manager found'));
        }
        void this.getPackageManagerCapability(context, PackageCapability.List, manager.project)
            .catch(logCapabilityQueryError);
        return manager.refresh(context);
    }
    async getPackages(context: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        await waitForEnvManagerId([context.envId.managerId]);
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            return Promise.resolve(undefined);
        }
        void this.getPackageManagerCapability(context, PackageCapability.List, manager.project)
            .catch(logCapabilityQueryError);
        return manager.getPackages(context, options);
    }
    getPackageAvailableVersions(
        context: PythonEnvironment,
        packageName: string,
        options: GetPackageAvailableVersionsOptions & { errorMode: 'throw' },
    ): Promise<Pep440Version[]>;
    getPackageAvailableVersions(
        context: PythonEnvironment,
        packageName: string,
        options?: GetPackageAvailableVersionsOptions,
    ): Promise<Pep440Version[] | undefined>;
    async getPackageAvailableVersions(
        context: PythonEnvironment,
        packageName: string,
        options?: GetPackageAvailableVersionsOptions,
    ): Promise<Pep440Version[] | undefined> {
        await waitForEnvManagerId([context.envId.managerId]);
        const manager = this.envManagers.getPackageManager(context);
        if (!manager) {
            if (options?.errorMode === 'throw') {
                throw new PackageVersionLookupNotSupportedError(
                    `No package manager is available to look up versions for: ${context.envId.id}`,
                );
            }
            return undefined;
        }
        void this.getPackageManagerCapability(context, PackageCapability.FetchAvailableVersions, manager.project)
            .catch(logCapabilityQueryError);
        return manager.getPackageAvailableVersions(context, packageName, options);
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
        return this.projectManager.get(checkUri(uri) as Uri);
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
        return Promise.resolve(terminal);
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
        return this.envVarManager.getEnvironmentVariables(checkUri(uri) as Uri, overrides, baseEnvVar);
    }
}

let _deferred = createDeferred<PythonEnvironmentApi>();
export function setPythonApi(
    envMgr: EnvironmentManagers,
    projectMgr: PythonProjectManager,
    projectCreators: ProjectCreators,
    terminalManager: TerminalManager,
    envVarManager: EnvVarManager,
) {
    _deferred.resolve(
        new PythonEnvironmentApiImpl(envMgr, projectMgr, projectCreators, terminalManager, envVarManager),
    );
}

export function getPythonApi(): Promise<PythonEnvironmentApi> {
    return _deferred.promise;
}
