import * as fs from 'fs/promises';
import * as path from 'path';
import {
    CancellationToken,
    EventEmitter,
    l10n,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
    Uri,
} from 'vscode';
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
    QuickCreateConfig,
    RefreshEnvironmentsScope,
    RemoveEnvironmentOptions,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { executeCommand } from '../../common/command.api';
import { PYTHON_EXTENSION_ID } from '../../common/constants';
import { VenvManagerStrings } from '../../common/localize';
import { traceError, traceWarn } from '../../common/logging';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { normalizePath } from '../../common/utils/pathUtils';
import { PythonVersion } from '../../common/pythonVersion';
import {
    EnvironmentToolSupport,
    PythonToolError,
    PythonToolOperation,
    pythonToolSupport,
    supportsEnvironmentTools,
    throwIfCancelled,
} from '../../internal/pythonToolSupport';
import { showErrorMessage, showInformationMessage, withProgress } from '../../common/window.apis';
import { findParentIfFile } from '../../features/envCommands';
import { getProjectFsPathForScope, tryFastPathGet } from '../common/fastPath';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { getLatest, shortenVersionString, sortEnvironments } from '../common/utils';
import { getDefaultGlobalPython } from './utils';
import { promptInstallPythonViaUv } from './uvPythonInstaller';
import {
    clearVenvCache,
    CreateEnvironmentResult,
    createPythonVenv,
    findVirtualEnvironments,
    getDefaultGlobalVenvLocation,
    getGlobalVenvLocation,
    getVenvForGlobal,
    getVenvForWorkspace,
    quickCreateVenv,
    removeVenv,
    resolveVenvPythonEnvironmentPath,
    setVenvForGlobal,
    setVenvForWorkspace,
    setVenvForWorkspaces,
} from './venvUtils';

export class VenvManager implements EnvironmentManager {
    private collection: PythonEnvironment[] = [];
    private environmentFolders: { collection: PythonEnvironment[]; length: number; folders: Set<string> } | undefined;
    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private readonly projectSelectionRevisions = new Map<string, number>();
    private globalEnv: PythonEnvironment | undefined;
    private skipWatcherRefresh = false;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    readonly name: string;
    readonly displayName: string;
    readonly preferredPackageManagerId: string;
    readonly description?: string | undefined;
    readonly tooltip?: string | MarkdownString | undefined;
    readonly iconPath?: IconPath | undefined;

    constructor(
        private readonly nativeFinder: NativePythonFinder,
        private readonly api: PythonEnvironmentApi,
        private readonly baseManager: EnvironmentManager,
        public readonly log: LogOutputChannel,
    ) {
        this.name = 'venv';
        this.displayName = 'venv';
        // Descriptions were a bit too visually noisy
        // https://github.com/microsoft/vscode-python-environments/issues/167
        this.description = undefined;
        this.tooltip = new MarkdownString(VenvManagerStrings.venvManagerDescription, true);
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.iconPath = new ThemeIcon('python');
    }

    private _initialized: Deferred<void> | undefined;
    private discovery: Deferred<void> | undefined;
    private initializationError: unknown;
    readonly [pythonToolSupport]: EnvironmentToolSupport = {
        initialize: async () => {
            if (!supportsEnvironmentTools(this.baseManager)) {
                throw new PythonToolError(
                    'UNSUPPORTED_MANAGER',
                    l10n.t('The base Python manager does not support non-interactive discovery.'),
                );
            }
            await this.baseManager[pythonToolSupport].initialize();
            await this.initializeDiscovery();
            if (this.initializationError) {
                throw this.initializationError;
            }
        },
        get: (scope) => this.get(scope, true),
        getEnvironments: (scope) => this.getEnvironments(scope, true),
        resolve: (scope) => this.resolve(scope),
        create: (scope, operation) => this.createForTools(scope, operation),
        set: (scope, environment, token) => this.set(scope, environment, token),
    };

    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }
        const initialized = (this._initialized = createDeferred<void>());
        try {
            await this.initializeWithBase();
        } catch (error) {
            if (this._initialized === initialized) {
                this._initialized = undefined;
            }
            throw error;
        } finally {
            initialized.resolve();
        }
    }

    private async initializeWithBase(): Promise<void> {
        await this.initializeDiscovery();
        const discovery = this.discovery;
        try {
            await this.loadGlobalEnv(await this.baseManager.getEnvironments('global'));
        } catch (error) {
            // Discovery alone is not a complete human initialization when the base step fails.
            if (this.discovery === discovery) {
                this.discovery = undefined;
            }
            throw error;
        }
    }

    private async initializeDiscovery(): Promise<void> {
        if (this.discovery) {
            return this.discovery.promise;
        }
        const discovery = (this.discovery = createDeferred());
        try {
            await this.internalRefresh(
                undefined,
                false,
                VenvManagerStrings.venvInitialize,
                ProgressLocation.Window,
                true,
            );
        } catch (error) {
            this.initializationError = error;
            this.discovery = undefined;
            throw error;
        } finally {
            discovery.resolve();
        }
    }

    private async createForTools(scope: Uri, operation: PythonToolOperation): Promise<PythonEnvironment> {
        const base =
            operation.baseEnvironment ??
            getLatest(
                (await operation.getGlobalEnvironments()).filter(
                    (environment) => PythonVersion.tryParse(environment.version)?.major === 3,
                ),
            );
        if (!base || PythonVersion.tryParse(base.version)?.major !== 3) {
            throw new PythonToolError(
                'MISSING_PYTHON',
                l10n.t('Install or select Python 3 before creating a virtual environment.'),
            );
        }
        throwIfCancelled(operation.token);
        this.skipWatcherRefresh = true;
        try {
            const result = await quickCreateVenv(
                this.nativeFinder,
                this.api,
                this.log,
                this,
                base,
                scope,
                undefined,
                operation,
            );
            if (!result?.environment) {
                throw new PythonToolError(
                    'CREATION_FAILED',
                    result?.envCreationErr ?? l10n.t('Virtual environment creation returned no environment.'),
                );
            }
            this.addEnvironment(result.environment, true);
            try {
                await fs.writeFile(path.join(result.environment.sysPrefix, '.gitignore'), '*\n', { flag: 'w' });
            } catch (error) {
                throw new PythonToolError(
                    'CREATION_FAILED',
                    l10n.t(
                        'The environment was created, but writing its .gitignore failed: {0}',
                        error instanceof Error ? error.message : String(error),
                    ),
                    result.environment,
                );
            }
            return result.environment;
        } catch (error) {
            if (error instanceof PythonToolError && error.environment) {
                this.addEnvironment(error.environment, true);
            }
            throw error;
        } finally {
            this.skipWatcherRefresh = false;
        }
    }

    /**
     * Returns configuration for quick create in the workspace root, undefined if no suitable Python 3 version is found.
     */
    quickCreateConfig(): QuickCreateConfig | undefined {
        if (!this.globalEnv || PythonVersion.tryParse(this.globalEnv.version)?.major !== 3) {
            return undefined;
        }
        return {
            description: l10n.t('Create a virtual environment in workspace root'),
            detail: l10n.t(
                'Uses Python version {0} and installs workspace dependencies.',
                shortenVersionString(this.globalEnv.version),
            ),
        };
    }

    async create(
        scope: CreateEnvironmentScope,
        options: CreateEnvironmentOptions | undefined,
    ): Promise<PythonEnvironment | undefined> {
        try {
            this.skipWatcherRefresh = true;
            let isGlobal = scope === 'global';
            if (Array.isArray(scope) && scope.length > 1) {
                isGlobal = true;
            }
            let uri: Uri | undefined = undefined;
            if (isGlobal) {
                uri = options?.quickCreate ? await getDefaultGlobalVenvLocation() : await getGlobalVenvLocation();
            } else {
                uri = scope instanceof Uri ? scope : (scope as Uri[])[0];
            }

            if (!uri) {
                return;
            }

            const venvRoot: Uri = Uri.file(await findParentIfFile(uri.fsPath));

            let globals = await this.api.getEnvironments('global');

            // If no Python environments found, offer to install Python via uv
            if (globals.length === 0) {
                const installedPath = await promptInstallPythonViaUv('createEnvironment', this.log);
                if (installedPath) {
                    // Refresh environments to detect the newly installed Python
                    await this.api.refreshEnvironments(undefined);
                    // Re-fetch environments after refresh
                    globals = await this.api.getEnvironments('global');
                    // Update globalEnv reference if we found any Python 3.x environments
                    const python3Envs = globals.filter((e) => PythonVersion.tryParse(e.version)?.major === 3);
                    if (python3Envs.length === 0) {
                        this.log.warn('Python installed via uv but no Python 3.x global environments were detected.');
                    } else {
                        this.globalEnv = getLatest(python3Envs);
                    }
                }
            }

            let result: CreateEnvironmentResult | undefined = undefined;
            if (options?.quickCreate) {
                // error on missing information
                if (!this.globalEnv) {
                    this.log.error('No base python found');
                    showErrorMessage(VenvManagerStrings.venvErrorNoBasePython);
                    throw new Error('No base python found');
                }
                if (PythonVersion.tryParse(this.globalEnv.version)?.major !== 3) {
                    this.log.error('Did not find any base python 3.*');
                    globals.forEach((e, i) => {
                        this.log.error(`${i}: ${e.version} : ${e.environmentPath.fsPath}`);
                    });
                    showErrorMessage(VenvManagerStrings.venvErrorNoPython3);
                    throw new Error('Did not find any base python 3.*');
                }
                if (this.globalEnv && PythonVersion.tryParse(this.globalEnv.version)?.major === 3) {
                    // quick create given correct information
                    result = await quickCreateVenv(
                        this.nativeFinder,
                        this.api,
                        this.log,
                        this,
                        this.globalEnv,
                        venvRoot,
                        options?.additionalPackages,
                    );
                }
            } else {
                // If quickCreate is not set that means the user triggered this method from
                // environment manager View, by selecting the venv manager.
                result = await createPythonVenv(this.nativeFinder, this.api, this.log, this, globals, venvRoot, {
                    showQuickAndCustomOptions: options?.quickCreate === undefined,
                });
            }

            if (result?.environment) {
                const environment = result.environment;

                this.addEnvironment(environment, true);

                // Add .gitignore to the .venv folder
                try {
                    // determine if env path is python binary or environment folder
                    let envPath = environment.environmentPath.fsPath;
                    try {
                        const stat = await fs.stat(envPath);
                        if (!stat.isDirectory()) {
                            // If the env path is a file (likely the python binary), use parent-parent as the env path
                            // following format of .venv/bin/python or .venv\Scripts\python.exe
                            envPath = Uri.file(path.dirname(path.dirname(envPath))).fsPath;
                        }
                    } catch (err) {
                        // If stat fails, fallback to original envPath
                        traceWarn(
                            `Failed to stat environment path: ${envPath}. Error: ${
                                err instanceof Error ? err.message : String(err)
                            }, continuing to attempt to create .gitignore.`,
                        );
                    }
                    const gitignorePath = path.join(envPath, '.gitignore');
                    await fs.writeFile(gitignorePath, '*\n', { flag: 'w' });
                } catch (err) {
                    traceError(
                        `Failed to create .gitignore in venv: ${
                            err instanceof Error ? err.message : String(err)
                        }, continuing.`,
                    );
                }

                // Open the parent folder of the venv in the current window immediately after creation
                const envParent = environment.sysPrefix;
                try {
                    await executeCommand('revealInExplorer', Uri.file(envParent));
                } catch (error) {
                    showErrorMessage(
                        l10n.t(
                            'Failed to reveal venv parent folder in VS Code Explorer: but venv was still created in {0}',
                            envParent,
                        ),
                    );
                    traceError(
                        `Failed to reveal venv parent folder in VS Code Explorer: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            } else if (result?.envCreationErr) {
                // Show error message to user when environment creation failed
                showErrorMessage(l10n.t('Failed to create virtual environment: {0}', result.envCreationErr));
            }
            return result?.environment ?? undefined;
        } finally {
            this.skipWatcherRefresh = false;
        }
    }

    /**
     * Removes the specified Python environment, updates internal collections, and fires change events as needed.
     */
    async remove(environment: PythonEnvironment, options?: RemoveEnvironmentOptions): Promise<void> {
        try {
            this.skipWatcherRefresh = true;

            const isRemoved = await removeVenv(environment, this.log, options);
            if (!isRemoved) {
                return;
            }
            this.updateCollection(environment);
            this._onDidChangeEnvironments.fire([{ environment, kind: EnvironmentChangeKind.remove }]);

            const changedUris = this.updateFsPathToEnv(environment);

            for (const uri of changedUris) {
                const newEnv = await this.get(uri);
                this._onDidChangeEnvironment.fire({ uri, old: environment, new: newEnv });
            }

            if (this.globalEnv?.envId.id === environment.envId.id) {
                await this.set(undefined, undefined);
            }
        } finally {
            this.skipWatcherRefresh = false;
        }
    }

    private updateCollection(environment: PythonEnvironment): void {
        const envPath = normalizePath(environment.environmentPath.fsPath);
        this.collection = this.collection.filter((e) => normalizePath(e.environmentPath.fsPath) !== envPath);
    }

    private updateFsPathToEnv(environment: PythonEnvironment): Uri[] {
        const envPath = normalizePath(environment.environmentPath.fsPath);
        const changed: Uri[] = [];
        this.fsPathToEnv.forEach((env, uri) => {
            if (normalizePath(env.environmentPath.fsPath) === envPath) {
                this.setProjectSelection(uri, undefined);
                changed.push(Uri.file(uri));
            }
        });
        return changed;
    }

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        return this.internalRefresh(scope, true, VenvManagerStrings.venvRefreshing);
    }

    async watcherRefresh(): Promise<void> {
        if (this.skipWatcherRefresh) {
            return;
        }
        return this.internalRefresh(undefined, true, VenvManagerStrings.venvRefreshing);
    }

    /**
     * Returns true when a known virtual environment is at, or inside, the given path.
     *
     * Called for every deletion in the workspace, so it is a single set lookup: the set holds every
     * environment prefix and its parent folders, and is rebuilt when the collection changes.
     *
     * @param fsPath A file system path, for example of a deleted folder.
     */
    hasEnvironmentAt(fsPath: string): boolean {
        const cache = this.environmentFolders;
        if (cache?.collection !== this.collection || cache.length !== this.collection.length) {
            const folders = new Set<string>();
            for (const env of this.collection) {
                let folder = env.sysPrefix ? path.resolve(env.sysPrefix) : undefined;
                while (folder && !folders.has(normalizePath(folder))) {
                    folders.add(normalizePath(folder));
                    const parent = path.dirname(folder);
                    folder = parent !== folder ? parent : undefined;
                }
            }
            this.environmentFolders = { collection: this.collection, length: this.collection.length, folders };
        }
        return this.environmentFolders!.folders.has(normalizePath(path.resolve(fsPath)));
    }

    private async internalRefresh(
        scope: RefreshEnvironmentsScope,
        hardRefresh: boolean,
        title: string,
        location: ProgressLocation = ProgressLocation.Window,
        toolExecution = false,
    ): Promise<void> {
        const selectionRevisions = new Map(this.projectSelectionRevisions);
        await withProgress(
            {
                location,
                title,
            },
            async () => {
                const discard = this.collection.map((env) => ({
                    kind: EnvironmentChangeKind.remove,
                    environment: env,
                }));

                this.collection =
                    (await findVirtualEnvironments(
                        hardRefresh,
                        this.nativeFinder,
                        this.api,
                        this.log,
                        this,
                        scope ? [scope] : undefined,
                    )) ?? [];
                await this.loadEnvMap(selectionRevisions, toolExecution);

                const added = this.collection.map((env) => ({ environment: env, kind: EnvironmentChangeKind.add }));
                this._onDidChangeEnvironments.fire([...discard, ...added]);
                this.initializationError = undefined;
            },
        );
    }

    async getEnvironments(scope: GetEnvironmentsScope, toolExecution = false): Promise<PythonEnvironment[]> {
        await (toolExecution ? this.initializeDiscovery() : this.initialize());

        if (scope === 'all') {
            return Array.from(this.collection);
        }
        if (!(scope instanceof Uri)) {
            return [];
        }

        const env = this.fsPathToEnv.get(normalizePath(scope.fsPath));
        return env ? [env] : [];
    }

    async get(scope: GetEnvironmentScope, toolExecution = false): Promise<PythonEnvironment | undefined> {
        const fastResult = toolExecution ? undefined : await tryFastPathGet({
            initialized: this._initialized,
            setInitialized: (deferred) => {
                this._initialized = deferred;
            },
            scope,
            label: 'venv',
            getProjectFsPath: (s) => getProjectFsPathForScope(this.api, s),
            getPersistedPath: (fsPath) => getVenvForWorkspace(fsPath),
            resolve: (p) => resolveVenvPythonEnvironmentPath(p, this.nativeFinder, this.api, this, this.baseManager),
            startBackgroundInit: () => this.initializeWithBase(),
        });
        if (fastResult) {
            return fastResult.env;
        }

        await (toolExecution ? this.initializeDiscovery() : this.initialize());

        if (!scope) {
            // `undefined` for venv scenario return the global environment.
            return this.globalEnv;
        }

        const project = this.api.getPythonProject(scope);
        if (!project) {
            return this.globalEnv;
        }

        let env = this.fsPathToEnv.get(normalizePath(project.uri.fsPath));
        if (!env) {
            env = this.findEnvironmentByPath(project.uri.fsPath);
        }

        return env ?? this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment, token?: CancellationToken): Promise<void> {
        throwIfCancelled(token);
        if (scope === undefined) {
            const before = this.globalEnv;
            this.globalEnv = environment;
            await setVenvForGlobal(environment?.environmentPath.fsPath);
            await this.resetGlobalEnv();
            if (before?.envId.id !== this.globalEnv?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: undefined, old: before, new: this.globalEnv });
            }
            return;
        }

        if (scope instanceof Uri) {
            const pw = this.api.getPythonProject(scope);
            if (!pw) {
                return;
            }

            // Notify user if VIRTUAL_ENV is set and they're trying to select a different environment
            if (!token && process.env.VIRTUAL_ENV && environment) {
                const virtualEnvPath = process.env.VIRTUAL_ENV;
                const selectedPath = environment.sysPrefix;
                // Only show notification if they selected a different environment
                if (virtualEnvPath !== selectedPath) {
                    showInformationMessage(VenvManagerStrings.venvVirtualEnvActive);
                }
            }

            const before = this.setProjectSelection(pw.uri.fsPath, environment);
            await setVenvForWorkspace(pw.uri.fsPath, environment?.environmentPath.fsPath);

            if (before?.envId.id !== environment?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: scope, old: before, new: environment });
            }
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
                before.set(p.uri.fsPath, this.setProjectSelection(p.uri.fsPath, environment));
            });

            await setVenvForWorkspaces(
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

    private setProjectSelection(
        fsPath: string,
        environment: PythonEnvironment | undefined,
    ): PythonEnvironment | undefined {
        const key = normalizePath(fsPath);
        const before = this.fsPathToEnv.get(key);
        this.projectSelectionRevisions.set(key, (this.projectSelectionRevisions.get(key) ?? 0) + 1);
        if (environment) {
            this.fsPathToEnv.set(key, environment);
        } else {
            this.fsPathToEnv.delete(key);
        }
        return before;
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        if (context instanceof Uri) {
            // NOTE: `environmentPath` for envs in `this.collection` for venv always points to the python
            // executable in the venv. This is set when we create the PythonEnvironment object.
            const found = this.findEnvironmentByPath(context.fsPath);
            if (found) {
                // If it is in the collection, then it is a venv, and it should already be fully resolved.
                return found;
            }
        }

        const resolved = await resolveVenvPythonEnvironmentPath(
            context.fsPath,
            this.nativeFinder,
            this.api,
            this,
            this.baseManager,
        );
        if (resolved) {
            if (resolved.envId.managerId === `${PYTHON_EXTENSION_ID}:venv`) {
                // We should only return the resolved env if it is a venv.
                // Fall through an return undefined if it is not a venv
                this.addEnvironment(resolved, true);
                return resolved;
            }
        }

        return undefined;
    }

    async clearCache(): Promise<void> {
        await clearVenvCache();
    }

    private addEnvironment(environment: PythonEnvironment, raiseEvent?: boolean): void {
        if (this.collection.find((e) => e.envId.id === environment.envId.id)) {
            return;
        }

        const oldEnv = this.findEnvironmentByPath(environment.environmentPath.fsPath);
        if (oldEnv) {
            this.collection = this.collection.filter((e) => e.envId.id !== oldEnv.envId.id);
            this.collection.push(environment);
            if (raiseEvent) {
                this._onDidChangeEnvironments.fire([
                    { environment: oldEnv, kind: EnvironmentChangeKind.remove },
                    { environment, kind: EnvironmentChangeKind.add },
                ]);
            }
        } else {
            this.collection.push(environment);
            if (raiseEvent) {
                this._onDidChangeEnvironments.fire([{ environment, kind: EnvironmentChangeKind.add }]);
            }
        }
    }

    private async resetGlobalEnv() {
        this.globalEnv = undefined;
        const globals = await this.baseManager.getEnvironments('global');
        await this.loadGlobalEnv(globals);
    }

    /**
     * Loads and sets the global Python environment from the provided list, resolving if necessary. O(g) where g = globals.length
     */
    private async loadGlobalEnv(globals: PythonEnvironment[]) {
        this.globalEnv = undefined;

        // Try to find a global environment
        const fsPath = await getVenvForGlobal();

        if (fsPath) {
            this.globalEnv = this.findEnvironmentByPath(fsPath) ?? this.findEnvironmentByPath(fsPath, globals);

            // If the environment is not found, resolve the fsPath. Could be portable conda.
            if (!this.globalEnv) {
                this.globalEnv = await resolveVenvPythonEnvironmentPath(
                    fsPath,
                    this.nativeFinder,
                    this.api,
                    this,
                    this.baseManager,
                );

                // If the environment is resolved, add it to the collection
                if (this.globalEnv) {
                    this.addEnvironment(this.globalEnv, false);
                }
            }
        }

        // If a global environment is still not set, use latest from globals
        if (!this.globalEnv) {
            this.globalEnv = getDefaultGlobalPython(globals);
        }
    }

    /**
     * Loads and maps Python environments to their corresponding project paths in the workspace. about  O(p × e) where p = projects.len and e = environments.len
     * Preserves project selections changed after this refresh began, including queued change notifications.
     * Skips unresolvable selections without preventing other projects from restoring their environments.
     */
    private async loadEnvMap(selectionRevisions: ReadonlyMap<string, number>, toolExecution = false) {
        const isCurrent = (key: string) => this.projectSelectionRevisions.get(key) === selectionRevisions.get(key);
        const tools = supportsEnvironmentTools(this.baseManager) ? this.baseManager[pythonToolSupport] : undefined;
        const globals = await (toolExecution && tools?.getEnvironments
            ? tools.getEnvironments('global')
            : this.baseManager.getEnvironments('global'));
        await this.loadGlobalEnv(globals);

        this.fsPathToEnv.forEach((_env, key) => {
            if (isCurrent(key)) {
                this.fsPathToEnv.delete(key);
            }
        });

        const sorted = sortEnvironments(this.collection);
        const projects = this.api.getPythonProjects();
        const events: (() => void)[] = [];
        // Iterates through all workspace projects
        for (const project of projects) {
            const originalPath = project.uri.fsPath;
            const normalizedPath = normalizePath(originalPath);
            const env = await getVenvForWorkspace(originalPath);
            if (!isCurrent(normalizedPath)) {
                continue;
            }
            if (env) {
                // from env path find PythonEnvironment object in the collection.
                let foundEnv = this.findEnvironmentByPath(env, sorted) ?? this.findEnvironmentByPath(env, globals);
                const previousEnv = this.fsPathToEnv.get(normalizedPath);
                if (!foundEnv) {
                    // attempt to resolve
                    const resolved = await resolveVenvPythonEnvironmentPath(
                        env,
                        this.nativeFinder,
                        this.api,
                        this,
                        this.baseManager,
                    );
                    if (!isCurrent(normalizedPath)) {
                        continue;
                    }
                    if (resolved) {
                        // If resolved; add it to the venvManager collection
                        this.addEnvironment(resolved, false);
                        foundEnv = resolved;
                    } else {
                        this.log.error(`Failed to resolve python environment: ${env}`);
                        continue;
                    }
                }
                // Given found env, add it to the map and fire the event if needed.
                this.fsPathToEnv.set(normalizedPath, foundEnv);
                if (previousEnv?.envId.id !== foundEnv.envId.id) {
                    events.push(() => {
                        if (isCurrent(normalizedPath)) {
                            this._onDidChangeEnvironment.fire({ uri: project.uri, old: undefined, new: foundEnv });
                        }
                    });
                }
            } else {
                // Search through all known environments (e) and check if any are associated with the current project path. If so, add that environment and path in the map.
                const projectEnvs = sorted.filter((e) => {
                    const t = this.api.getPythonProject(e.environmentPath)?.uri.fsPath;
                    return t && normalizePath(t) === normalizedPath;
                });
                // Prefer the project's own environment (e.g. `<project>/.venv`) over one nested in a
                // subfolder (e.g. `<project>/tools/.venv`), even when the nested one has a newer Python.
                // Broken environments are not preferred, matching their last place in the sort order.
                const found =
                    projectEnvs.find(
                        (e) => !e.error && normalizePath(path.dirname(e.sysPrefix)) === normalizedPath,
                    ) ?? projectEnvs[0];
                if (found) {
                    this.fsPathToEnv.set(normalizedPath, found);
                }
            }
        }

        events.forEach((e) => e());
    }

    /**
     * Finds a PythonEnvironment in the given collection (or all environments) that matches the provided file system path. O(e) where e = environments.len
     */
    private findEnvironmentByPath(fsPath: string, collection?: PythonEnvironment[]): PythonEnvironment | undefined {
        const normalized = normalizePath(fsPath);
        const envs = collection ?? this.collection;
        return envs.find((e) => {
            const n = normalizePath(e.environmentPath.fsPath);
            return (
                n === normalized ||
                normalizePath(path.dirname(e.environmentPath.fsPath)) === normalized ||
                normalizePath(path.dirname(path.dirname(e.environmentPath.fsPath))) === normalized
            );
        });
    }

    /**
     * Returns all Python projects associated with the given environment.
     * O(p), where p is project.len
     */
    public getProjectsByEnvironment(environment: PythonEnvironment): PythonProject[] {
        const projects: PythonProject[] = [];
        this.fsPathToEnv.forEach((env, fsPath) => {
            if (env.envId.id === environment.envId.id) {
                const p = this.api.getPythonProject(Uri.file(fsPath));
                if (p) {
                    projects.push(p);
                }
            }
        });
        return projects;
    }
}
