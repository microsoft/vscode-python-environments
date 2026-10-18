import * as path from 'path';
import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import { EventEmitter, l10n, LogOutputChannel, MarkdownString, ProgressLocation, ThemeIcon, Uri } from 'vscode';
import {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { Capabilities, EnvironmentManagerCapability, supportedCapability, EnvironmentCapability } from '../../capabilities';
import { PythonInstallStrings, SysManagerStrings } from '../../common/localize';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { isFileNotFoundError } from '../../common/utils/filesystem';
import { PythonVersion } from '../../common/pythonVersion';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';
import { showErrorMessage, withProgress } from '../../common/window.apis';
import { EnvironmentToolSupport, pythonToolSupport } from '../../internal/pythonToolSupport';
import { getProjectFsPathForScope, tryFastPathGet } from '../common/fastPath';
import { NativePythonFinder } from '../common/nativePythonFinder';
import {
    clearSystemEnvCache,
    getSystemEnvForGlobal,
    getSystemEnvForWorkspace,
    setSystemEnvForGlobal,
    setSystemEnvForWorkspace,
    setSystemEnvForWorkspaces,
} from './cache';
import {
    getDefaultGlobalPython,
    getSystemPythonInfo,
    refreshPythons,
    resolveSystemPythonEnvironmentPath,
} from './utils';
import { promptInstallPython, selectAndInstallPython } from './pythonInstaller';
import { detectPymanager, listPymanagerRuntimes, PymanagerRuntime } from './pymanagerPythonInstaller';

interface SystemPythonInventory {
    readonly collection: PythonEnvironment[];
    readonly pymanagerPaths: Set<string>;
    readonly retainedPymanagerPaths: Set<string>;
}

export class SysPythonManager implements EnvironmentManager {
    readonly capabilities: Capabilities<EnvironmentManagerCapability> = {
        [EnvironmentCapability.List]: supportedCapability,
        [EnvironmentCapability.Resolve]: supportedCapability,
        [EnvironmentCapability.GetSelected]: supportedCapability,
        [EnvironmentCapability.SetSelected]: supportedCapability,
        [EnvironmentCapability.Create]: supportedCapability,
        [EnvironmentCapability.Remove]: async () => ({
            supported: false,
            reason: l10n.t('This environment manager does not support removing environments.'),
        }),
    };

    private collection: PythonEnvironment[] = [];
    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;
    private pymanagerPaths = new Set<string>();
    private retainedPymanagerPaths = new Set<string>();
    private inventoryOperations: Promise<void> = Promise.resolve();

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly description: string | undefined;
    public readonly tooltip: string | MarkdownString;
    public readonly iconPath: IconPath;

    constructor(
        private readonly nativeFinder: NativePythonFinder,
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
    ) {
        this.name = 'system';
        this.displayName = 'Global';
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.description = undefined;
        this.tooltip = new MarkdownString(SysManagerStrings.sysManagerDescription, true);
        this.iconPath = new ThemeIcon('globe');
    }

    private _initialized: Deferred<void> | undefined;
    private discovery: Deferred<void> | undefined;
    private initializationError: unknown;
    readonly [pythonToolSupport]: EnvironmentToolSupport = {
        initialize: async () => {
            await this.initializeDiscovery();
            if (this.initializationError) {
                throw this.initializationError;
            }
        },
        get: (scope) => this.get(scope, true),
        getEnvironments: (scope) => this.getEnvironments(scope, true),
        resolve: (scope) => this.resolve(scope),
    };

    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }
        this._initialized = createDeferred();
        try {
            await this.initializeDiscovery();

            // Only acquire a runtime after discovery has completed; the installer must not re-enter initialize().
            if (this.collection.length === 0) {
                const pythonPath = await promptInstallPython('activation', this.log);
                if (pythonPath) {
                    await this.selectInstalledPython(pythonPath);
                }
            }
        } finally {
            this._initialized.resolve();
        }
    }

    private async initializeDiscovery(): Promise<void> {
        if (this.discovery) {
            return this.discovery.promise;
        }
        const discovery = (this.discovery = createDeferred());
        try {
            await this.internalRefresh(false, SysManagerStrings.sysManagerDiscovering);
        } catch (error) {
            this.initializationError = error;
            this.discovery = undefined;
            throw error;
        } finally {
            discovery.resolve();
        }
    }

    refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        return this.internalRefresh(true, SysManagerStrings.sysManagerRefreshing);
    }

    private enqueueInventoryOperation<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.inventoryOperations.then(operation);
        this.inventoryOperations = next.then(() => undefined, () => undefined);
        return next;
    }

    private internalRefresh(hardRefresh: boolean, title: string): Promise<void> {
        return this.enqueueInventoryOperation(() => this.refreshInventory(hardRefresh, title));
    }

    private async refreshInventory(
        hardRefresh: boolean,
        title: string,
        publishChanges: boolean = true,
    ): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title,
            },
            async () => {
                const discard = this.collection.map((c) => c);
                const previousPymanagerPaths = new Set(this.pymanagerPaths);

                const managerRuntimes = this.getPymanagerRuntimes();
                const native = (await refreshPythons(hardRefresh, this.nativeFinder, this.api, this.log, this)) ?? [];
                const inventory = await this.includePymanagerRuntimes(
                    native, discard, await managerRuntimes, previousPymanagerPaths,
                );
                this.collection = inventory.collection;
                this.pymanagerPaths = inventory.pymanagerPaths;
                this.retainedPymanagerPaths = inventory.retainedPymanagerPaths;
                await this.loadEnvMap();

                const args = [
                    ...discard.map((e) => ({ environment: e, kind: EnvironmentChangeKind.remove })),
                    ...this.collection.map((e) => ({ environment: e, kind: EnvironmentChangeKind.add })),
                ];

                if (publishChanges) {
                    this._onDidChangeEnvironments.fire(args);
                }
                this.initializationError = undefined;
            },
        );
    }

    private async getPymanagerRuntimes(): Promise<PymanagerRuntime[] | undefined> {
        try {
            const manager = await detectPymanager();
            if (manager.kind === 'absent') {
                return [];
            }
            if (manager.kind === 'unusable') {
                this.log.warn(`PyManager runtime discovery is unavailable: ${manager.error.message}`);
                return undefined;
            }
            return await listPymanagerRuntimes(manager.executable, { onlyManaged: true });
        } catch (error) {
            this.log.warn(`Could not discover PyManager runtimes; retaining previous results: ${error}`);
            return undefined;
        }
    }

    private async includePymanagerRuntimes(
        native: PythonEnvironment[],
        previous: PythonEnvironment[],
        runtimes: PymanagerRuntime[] | undefined,
        previousPymanagerPaths: ReadonlySet<string>,
    ): Promise<SystemPythonInventory> {
        const result = new Map(native.map((environment) => [normalizePath(environment.environmentPath.fsPath), environment]));
        const retainedPaths = new Set<string>();
        if (runtimes === undefined) {
            for (const environment of previous) {
                const key = normalizePath(environment.environmentPath.fsPath);
                if (previousPymanagerPaths.has(key) && !result.has(key)) {
                    result.set(key, environment);
                }
            }
            return {
                collection: [...result.values()],
                pymanagerPaths: new Set(previousPymanagerPaths),
                retainedPymanagerPaths: new Set(previousPymanagerPaths),
            };
        }
        const nextPaths = new Set<string>();
        for (const runtime of runtimes) {
            if (
                runtime.unmanaged ||
                runtime.company.toLowerCase() !== 'pythoncore' ||
                runtime.executableArgs.length > 0 ||
                !runtime.prefix ||
                !PythonVersion.tryParse(runtime.version) ||
                !path.isAbsolute(runtime.prefix) ||
                !path.isAbsolute(runtime.executable) ||
                !isSameOrParentPath(runtime.prefix, runtime.executable) ||
                !/^python(?:\d+(?:\.\d+)*)?t?\.exe$/i.test(path.basename(runtime.executable))
            ) {
                continue;
            }
            let key = normalizePath(runtime.executable);
            try {
                if (!(await fs.stat(runtime.executable)).isFile() ||
                    await fs.pathExists(path.join(runtime.prefix, 'pyvenv.cfg'))) {
                    continue;
                }
                const [executable, prefix] = await Promise.all([
                    nativeFs.realpath(runtime.executable),
                    nativeFs.realpath(runtime.prefix),
                ]);
                if (!isSameOrParentPath(prefix, executable)) {
                    this.log.warn('A PyManager runtime resolved outside its reported prefix.');
                    continue;
                }
                key = normalizePath(executable);
                nextPaths.add(key);
                const discoveredVersion = PythonVersion.tryParse(result.get(key)?.version);
                const managedVersion = PythonVersion.tryParse(runtime.version);
                if (!result.has(key) || !discoveredVersion || managedVersion?.compareTo(discoveredVersion) !== 0) {
                    result.set(key, this.api.createPythonEnvironmentItem(getSystemPythonInfo({
                        executable,
                        version: runtime.version,
                        prefix,
                    }), this));
                }
            } catch (error) {
                if (!isFileNotFoundError(error)) {
                    this.log.warn(`Could not inspect a PyManager runtime: ${error}`);
                    const known = previous.find((environment) => normalizePath(environment.environmentPath.fsPath) === key);
                    if (known) {
                        result.set(key, known);
                        nextPaths.add(key);
                        retainedPaths.add(key);
                    }
                }
            }
        }
        return { collection: [...result.values()], pymanagerPaths: nextPaths, retainedPymanagerPaths: retainedPaths };
    }

    async getEnvironments(scope: GetEnvironmentsScope, toolExecution = false): Promise<PythonEnvironment[]> {
        await (toolExecution ? this.initializeDiscovery() : this.initialize());

        if (scope === 'all' || scope === 'global') {
            return Array.from(this.collection);
        }

        if (scope instanceof Uri) {
            const env = this.fsPathToEnv.get(normalizePath(scope.fsPath));
            if (env) {
                return [env];
            }
        }

        return [];
    }

    async get(scope: GetEnvironmentScope, toolExecution = false): Promise<PythonEnvironment | undefined> {
        const fastResult = toolExecution ? undefined : await tryFastPathGet({
            initialized: this._initialized,
            setInitialized: (deferred) => {
                this._initialized = deferred;
            },
            scope,
            label: 'system',
            getProjectFsPath: (s) => getProjectFsPathForScope(this.api, s),
            getPersistedPath: (fsPath) => getSystemEnvForWorkspace(fsPath),
            getGlobalPersistedPath: () => getSystemEnvForGlobal(),
            resolve: (p) => resolveSystemPythonEnvironmentPath(p, this.nativeFinder, this.api, this),
            startBackgroundInit: () => this.initializeDiscovery(),
        });
        if (fastResult) {
            return fastResult.env;
        }

        await (toolExecution ? this.initializeDiscovery() : this.initialize());

        if (scope instanceof Uri) {
            return this.fromEnvMap(scope) ?? this.globalEnv;
        }

        return this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (scope === undefined) {
            this.globalEnv = environment ?? getDefaultGlobalPython(this.collection);
            if (environment) {
                await setSystemEnvForGlobal(environment.environmentPath.fsPath);
            }
        }

        if (scope instanceof Uri) {
            const pw = this.api.getPythonProject(scope);
            if (!pw) {
                this.log.warn(
                    `[SYS_SET] Unable to set environment for ${scope.fsPath}: Not a python project. ` +
                        `Known projects: [${this.api
                            .getPythonProjects()
                            .map((p) => p.uri.fsPath)
                            .join(', ')}]`,
                );
                return;
            }

            const normalizedPwPath = normalizePath(pw.uri.fsPath);
            this.log.info(
                `[SYS_SET] scope=${scope.fsPath}, project=${pw.uri.fsPath}, ` +
                    `normalizedKey=${normalizedPwPath}, env=${environment?.envId?.id ?? 'undefined'}`,
            );
            if (environment) {
                this.fsPathToEnv.set(normalizedPwPath, environment);
            } else {
                this.fsPathToEnv.delete(normalizedPwPath);
            }
            await setSystemEnvForWorkspace(pw.uri.fsPath, environment?.environmentPath.fsPath);
        }

        if (Array.isArray(scope) && scope.every((u) => u instanceof Uri)) {
            const projects: PythonProject[] = [];
            scope
                .map((s) => this.api.getPythonProject(s))
                .forEach((p) => {
                    if (p) {
                        projects.push(p);
                    }
                });

            const before: Map<string, PythonEnvironment | undefined> = new Map();
            projects.forEach((p) => {
                const normalizedPath = normalizePath(p.uri.fsPath);
                before.set(p.uri.fsPath, this.fsPathToEnv.get(normalizedPath));
                if (environment) {
                    this.fsPathToEnv.set(normalizedPath, environment);
                } else {
                    this.fsPathToEnv.delete(normalizedPath);
                }
            });

            await setSystemEnvForWorkspaces(
                projects.map((p) => p.uri.fsPath),
                environment?.environmentPath.fsPath,
            );

            projects.forEach((p) => {
                const b = before.get(p.uri.fsPath);
                if (b?.envId.id !== environment?.envId.id) {
                    this._onDidChangeEnvironment.fire({ uri: p.uri, old: b, new: environment });
                }
            });
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        // NOTE: `environmentPath` for envs in `this.collection` for system envs always points to the python
        // executable. This is set when we create the PythonEnvironment object.
        const found = this.findEnvironmentByPath(context.fsPath);
        if (found) {
            // If it is in the collection, then it is a venv, and it should already be fully resolved.
            return found;
        }

        // This environment is unknown. Resolve it.
        const resolved = await resolveSystemPythonEnvironmentPath(context.fsPath, this.nativeFinder, this.api, this);
        if (resolved) {
            // This is just like finding a new environment or creating a new one.
            // Add it to collection, and trigger the added event.

            // For all other env types we need to ensure that the environment is of the type managed by the manager.
            // But System is a exception, this is the last resort for resolving. So we don't need to check.
            // We will just add it and treat it as a non-activatable environment.
            const exists = this.collection.some(
                (e) => e.environmentPath.toString() === resolved.environmentPath.toString(),
            );
            if (!exists) {
                // only add it if it is not already in the collection to avoid duplicates
                this.collection.push(resolved);
            }
            this._onDidChangeEnvironments.fire([{ environment: resolved, kind: EnvironmentChangeKind.add }]);
        }

        return resolved;
    }

    /**
     * Installs a global Python using the platform's available runtime installer.
     * This method shows a QuickPick to select the Python version, then installs it.
     */
    async create(
        _scope: CreateEnvironmentScope,
        _options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        const pythonPath = await selectAndInstallPython(this.log);
        return pythonPath ? this.selectInstalledPython(pythonPath) : undefined;
    }

    private selectInstalledPython(pythonPath: string): Promise<PythonEnvironment | undefined> {
        // Keep refresh publication and its dependent freshness decision in one operation.
        return this.enqueueInventoryOperation(() => this.selectInstalledPythonCore(pythonPath));
    }

    private async selectInstalledPythonCore(pythonPath: string): Promise<PythonEnvironment | undefined> {
        // Refresh also supplies PyManager installations which PET cannot discover.
        // Do not select a previous inventory entry if that refresh failed.
        const previous = this.findEnvironmentByPath(pythonPath);
        let refreshed = false;
        try {
            await this.refreshInventory(true, SysManagerStrings.sysManagerRefreshing, false);
            refreshed = true;
        } catch (error) {
            this.log.warn(`Python was installed, but discovery could not be refreshed: ${error}`);
        }
        const discovered = refreshed ? this.findEnvironmentByPath(pythonPath) : undefined;
        const fresh = discovered && !this.retainedPymanagerPaths.has(normalizePath(discovered.environmentPath.fsPath))
            ? discovered
            : undefined;
        const resolved = fresh ??
            await resolveSystemPythonEnvironmentPath(pythonPath, this.nativeFinder, this.api, this);
        if (!resolved) {
            this.log.error(`The installed Python could not be resolved at ${pythonPath}.`);
            void showErrorMessage(PythonInstallStrings.discoveryFailed);
            return undefined;
        }
        const existingIndex = this.collection.findIndex(
            (environment) => normalizePath(environment.environmentPath.fsPath) === normalizePath(resolved.environmentPath.fsPath),
        );
        const current = existingIndex >= 0 ? this.collection[existingIndex] : undefined;
        const selected = current?.version === resolved.version ? current : resolved;
        if (existingIndex >= 0) {
            this.collection[existingIndex] = selected;
        } else {
            this.collection.push(selected);
        }
        this.retainedPymanagerPaths.delete(normalizePath(selected.environmentPath.fsPath));
        for (const [scope, environment] of this.fsPathToEnv) {
            if (normalizePath(environment.environmentPath.fsPath) === normalizePath(selected.environmentPath.fsPath)) {
                this.fsPathToEnv.set(scope, selected);
            }
        }
        this.globalEnv = selected;
        await setSystemEnvForGlobal(selected.environmentPath.fsPath);
        const selectionChanged =
            !previous ||
            previous.version !== selected.version ||
            normalizePath(previous.environmentPath.fsPath) !== normalizePath(selected.environmentPath.fsPath);
        if (selectionChanged) {
            this._onDidChangeEnvironments.fire([
                ...(previous ? [{ environment: previous, kind: EnvironmentChangeKind.remove }] : []),
                { environment: selected, kind: EnvironmentChangeKind.add },
            ]);
        }
        return selected;
    }

    async clearCache(): Promise<void> {
        await clearSystemEnvCache();
    }

    private findEnvironmentByPath(fsPath: string): PythonEnvironment | undefined {
        const normalized = normalizePath(fsPath);
        return this.collection.find((e) => {
            const n = normalizePath(e.environmentPath.fsPath);
            return (
                n === normalized ||
                normalizePath(path.dirname(e.environmentPath.fsPath)) === normalized ||
                normalizePath(path.dirname(path.dirname(e.environmentPath.fsPath))) === normalized
            );
        });
    }

    private fromEnvMap(uri: Uri): PythonEnvironment | undefined {
        const normalizedUri = normalizePath(uri.fsPath);
        // Find environment directly using the URI mapping
        const env = this.fsPathToEnv.get(normalizedUri);
        if (env) {
            return env;
        }

        // Find environment using the Python project for the Uri
        const project = this.api.getPythonProject(uri);
        const projectKey = project ? normalizePath(project.uri.fsPath) : undefined;
        const projectEnv = projectKey ? this.fsPathToEnv.get(projectKey) : undefined;

        this.log.info(
            `[SYS_GET] uri=${uri.fsPath}, normalizedKey=${normalizedUri}, ` +
                `project=${project?.uri?.fsPath ?? 'none'}, projectKey=${projectKey ?? 'none'}, ` +
                `mapKeys=[${Array.from(this.fsPathToEnv.keys()).join(', ')}], ` +
                `directHit=${!!env}, projectHit=${!!projectEnv}, ` +
                `fallbackToGlobal=${!projectEnv}, globalEnv=${this.globalEnv?.envId?.id ?? 'none'}`,
        );

        if (projectEnv) {
            return projectEnv;
        }

        return this.globalEnv;
    }

    private async loadEnvMap() {
        this.globalEnv = undefined;
        this.fsPathToEnv.clear();

        // Try to find a global environment
        const fsPath = await getSystemEnvForGlobal();

        if (fsPath) {
            this.globalEnv = this.findEnvironmentByPath(fsPath);

            // If the environment is not found, resolve the fsPath.
            if (!this.globalEnv) {
                const resolved = await resolveSystemPythonEnvironmentPath(fsPath, this.nativeFinder, this.api, this);
                this.globalEnv = resolved ? this.trackResolvedEnvironment(resolved) : undefined;
            }
        }

        // If a global environment is still not set, try using the latest environment
        if (!this.globalEnv) {
            this.globalEnv = getDefaultGlobalPython(this.collection);
        }

        // Try to find workspace environments
        const projects = this.api.getPythonProjects();

        // Iterate over each project
        for (const project of projects) {
            const originalPath = project.uri.fsPath;
            const normalizedPath = normalizePath(originalPath);
            const env = await getSystemEnvForWorkspace(originalPath);

            if (env) {
                const found = this.findEnvironmentByPath(env);

                if (found) {
                    this.fsPathToEnv.set(normalizedPath, found);
                } else {
                    // If not found, resolve the path.
                    const resolved = await resolveSystemPythonEnvironmentPath(env, this.nativeFinder, this.api, this);

                    if (resolved) {
                        this.fsPathToEnv.set(normalizedPath, this.trackResolvedEnvironment(resolved));
                    } else {
                        this.log.error(`Failed to resolve python environment: ${env}`);
                    }
                }
            }
        }
    }

    /**
     * Returns the collection entry for a resolved environment, adding it only when its interpreter is not
     * already listed. A saved path can be an alias of a discovered interpreter (for example a symlink or
     * uv's `~/.local/bin` launchers), which resolves to an environment the collection already contains.
     * The result is `resolved` itself only when it was added.
     */
    private trackResolvedEnvironment(resolved: PythonEnvironment): PythonEnvironment {
        const key = normalizePath(resolved.environmentPath.fsPath);
        const existing = this.collection.find((e) => normalizePath(e.environmentPath.fsPath) === key);
        if (existing) {
            return existing;
        }
        this.collection.push(resolved);
        return resolved;
    }
}
