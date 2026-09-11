import * as path from 'path';
import * as fs from 'fs-extra';
import {
    CancellationError,
    CancellationToken,
    Disposable,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    Uri,
    workspace,
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
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { PoetryStrings } from '../../common/localize';
import { traceError, traceInfo } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { normalizePath } from '../../common/utils/pathUtils';
import { withProgress } from '../../common/window.apis';
import { findParentIfFile } from '../../features/envCommands';
import { PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { getLatest, notifyMissingManagerIfDefault } from '../common/utils';
import { runPoetry } from './commands/runPoetry';
import {
    clearPoetryCache,
    getPoetry,
    getPoetryForGlobal,
    getPoetryForWorkspace,
    POETRY_GLOBAL,
    refreshPoetry,
    resolvePoetryPath,
    setPoetryForGlobal,
    setPoetryForWorkspace,
    setPoetryForWorkspaces,
} from './poetryUtils';

export class PoetryManager implements EnvironmentManager, Disposable {
    private collection: PythonEnvironment[] = [];
    private fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    constructor(
        private readonly nativeFinder: NativePythonFinder,
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly projectManager?: PythonProjectManager,
    ) {
        this.name = 'poetry';
        this.displayName = 'Poetry';
        this.preferredPackageManagerId = 'ms-python.python:poetry';
        this.tooltip = new MarkdownString(PoetryStrings.poetryManager, true);
    }

    name: string;
    displayName: string;
    preferredPackageManagerId: string;
    description?: string;
    tooltip: string | MarkdownString;
    iconPath?: IconPath;

    /**
     * Returns the configuration used to offer Poetry as a quick-create option.
     */
    public quickCreateConfig(): QuickCreateConfig {
        return {
            description: PoetryStrings.create.description,
        };
    }

    /**
     * Creates and selects a Poetry environment for a single existing Python project.
     */
    public async create(
        scope: CreateEnvironmentScope,
        options: CreateEnvironmentOptions = {},
    ): Promise<PythonEnvironment | undefined> {
        await this.initialize();
        const projectRoot = await this.getCreateProjectRoot(scope);
        const pyprojectPath = path.join(projectRoot.fsPath, 'pyproject.toml');
        if (!(await fs.pathExists(pyprojectPath))) {
            throw new Error(PoetryStrings.create.noPyproject(projectRoot.fsPath));
        }

        const baseEnvironment = await this.getBaseEnvironment();
        const pythonExecutable = baseEnvironment.execInfo?.run?.executable;
        if (!pythonExecutable) {
            throw new Error(PoetryStrings.create.noPython);
        }

        return withProgress(
            {
                location: ProgressLocation.Notification,
                title: PoetryStrings.create.progress(projectRoot.fsPath),
            },
            async (_, token) => {
                await runPoetry(['--no-ansi', 'env', 'use', pythonExecutable], projectRoot.fsPath, this.log, token);
                const result = await runPoetry(
                    ['--no-ansi', 'env', 'info', '--path'],
                    projectRoot.fsPath,
                    this.log,
                    token,
                );
                const environmentPath = this.parseEnvironmentPath(result);
                const resolvedEnvironment = await resolvePoetryPath(environmentPath, this.nativeFinder, this.api, this);
                if (!resolvedEnvironment) {
                    throw new Error(PoetryStrings.create.resolveFailed(environmentPath));
                }

                const existingEnvironment = this.collection.find((item) =>
                    this.sameEnvironment(item, resolvedEnvironment),
                );
                const environment = existingEnvironment ?? resolvedEnvironment;
                const previousEnvironment = this.fsPathToEnv.get(normalizePath(projectRoot.fsPath));
                await setPoetryForWorkspace(projectRoot.fsPath, environment.environmentPath.fsPath);
                if (!existingEnvironment) {
                    this.collection.push(environment);
                }
                this.fsPathToEnv.set(normalizePath(projectRoot.fsPath), environment);

                if (!existingEnvironment) {
                    this._onDidChangeEnvironments.fire([{ kind: EnvironmentChangeKind.add, environment }]);
                }
                this._onDidChangeEnvironment.fire({
                    uri: projectRoot,
                    old: previousEnvironment,
                    new: environment,
                });

                if (options.additionalPackages?.length) {
                    await runPoetry(
                        ['--no-ansi', 'add', ...options.additionalPackages],
                        projectRoot.fsPath,
                        this.log,
                        token,
                    );
                }

                return environment;
            },
        );
    }

    /**
     * Removes a Poetry environment from its associated project and clears the cached selection.
     */
    public async remove(environment: PythonEnvironment): Promise<void> {
        await this.initialize();
        const projectRoots = this.getAssociatedProjectRoots(environment);
        if (projectRoots.length === 0) {
            throw new Error(PoetryStrings.remove.noProject(environment.environmentPath.fsPath));
        }

        const pythonExecutable = environment.execInfo?.run?.executable;
        if (!pythonExecutable) {
            throw new Error(PoetryStrings.remove.noExecutable(environment.environmentPath.fsPath));
        }

        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: PoetryStrings.remove.progress(environment.environmentPath.fsPath),
            },
            async (_, token) => {
                const projectRoot = await this.findOwningProjectRoot(environment, projectRoots, token);
                await runPoetry(
                    ['--no-ansi', 'env', 'remove', pythonExecutable],
                    projectRoot.fsPath,
                    this.log,
                    token,
                );

                this.collection = this.collection.filter((item) => !this.sameEnvironment(item, environment));
                for (const root of projectRoots) {
                    const previousEnvironment = this.fsPathToEnv.get(normalizePath(root.fsPath));
                    this.fsPathToEnv.delete(normalizePath(root.fsPath));
                    await setPoetryForWorkspace(root.fsPath, undefined);
                    this._onDidChangeEnvironment.fire({
                        uri: root,
                        old: previousEnvironment ?? environment,
                        new: undefined,
                    });
                }

                if (this.globalEnv && this.sameEnvironment(this.globalEnv, environment)) {
                    const previousEnvironment = this.globalEnv;
                    this.globalEnv = undefined;
                    await setPoetryForGlobal(undefined);
                    this._onDidChangeEnvironment.fire({
                        uri: undefined,
                        old: previousEnvironment,
                        new: undefined,
                    });
                }

                this._onDidChangeEnvironments.fire([{ kind: EnvironmentChangeKind.remove, environment }]);
            },
        );
    }

    public dispose() {
        this.collection = [];
        this.fsPathToEnv.clear();
    }

    private _initialized: Deferred<void> | undefined;
    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }
        this._initialized = createDeferred();
        const stopWatch = new StopWatch();
        let result: 'success' | 'tool_not_found' | 'error' = 'success';
        let envCount = 0;
        let toolSource = 'none';
        let errorType: string | undefined;

        try {
            // Check if tool is findable before PET refresh (settings/cache/PATH only, no PET)
            const hasExplicitSetting = !!workspace.getConfiguration('python').get<string>('poetryPath');
            const preRefreshTool = await getPoetry();
            if (preRefreshTool) {
                toolSource = hasExplicitSetting ? 'settings' : 'local';
            }

            await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: PoetryStrings.poetryDiscovering,
                },
                async () => {
                    this.collection = (await refreshPoetry(false, this.nativeFinder, this.api, this)) ?? [];
                    await this.loadEnvMap();

                    this._onDidChangeEnvironments.fire(
                        this.collection.map((e) => ({ environment: e, kind: EnvironmentChangeKind.add })),
                    );
                },
            );

            envCount = this.collection.length;

            // If tool wasn't found via local lookup, check if refresh discovered it via PET
            if (!preRefreshTool) {
                const postRefreshTool = await getPoetry();
                toolSource = postRefreshTool ? 'pet' : 'none';
            }

            if (toolSource === 'none') {
                result = 'tool_not_found';
                if (this.projectManager) {
                    await notifyMissingManagerIfDefault('ms-python.python:poetry', this.projectManager, this.api);
                }
            }
        } catch (ex) {
            result = 'error';
            errorType = classifyError(ex);
            traceError('Poetry lazy initialization failed', ex);
        } finally {
            sendTelemetryEvent(EventNames.MANAGER_LAZY_INIT, stopWatch.elapsedTime, {
                managerName: 'poetry',
                result,
                envCount,
                toolSource,
                errorType,
            });
            this._initialized.resolve();
        }
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            return Array.from(this.collection);
        }

        if (scope === 'global') {
            return this.collection.filter((env) => {
                return env.group === POETRY_GLOBAL;
            });
        }

        if (scope instanceof Uri) {
            const env = this.fromEnvMap(scope);
            if (env) {
                return [env];
            }
        }

        return [];
    }

    async refresh(context: RefreshEnvironmentsScope): Promise<void> {
        if (context === undefined) {
            await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: PoetryStrings.poetryRefreshing,
                },
                async () => {
                    traceInfo('Refreshing Poetry Environments');
                    const discard = this.collection.map((c) => c);
                    this.collection = (await refreshPoetry(true, this.nativeFinder, this.api, this)) ?? [];

                    await this.loadEnvMap();

                    const args = [
                        ...discard.map((env) => ({ kind: EnvironmentChangeKind.remove, environment: env })),
                        ...this.collection.map((env) => ({ kind: EnvironmentChangeKind.add, environment: env })),
                    ];

                    this._onDidChangeEnvironments.fire(args);
                },
            );
        }
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        await this.initialize();
        if (scope instanceof Uri) {
            let env = this.fsPathToEnv.get(normalizePath(scope.fsPath));
            if (env) {
                return env;
            }
            const project = this.api.getPythonProject(scope);
            if (project) {
                env = this.fsPathToEnv.get(normalizePath(project.uri.fsPath));
                if (env) {
                    return env;
                }
            }
        }

        return this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment | undefined): Promise<void> {
        if (scope === undefined) {
            const previousEnvironment = this.globalEnv;
            await setPoetryForGlobal(environment?.environmentPath?.fsPath);
            this.globalEnv = environment;
            if (previousEnvironment?.envId.id !== environment?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: undefined, old: previousEnvironment, new: environment });
            }
        } else if (scope instanceof Uri) {
            const folder = this.api.getPythonProject(scope);
            const fsPath = folder?.uri?.fsPath ?? scope.fsPath;
            if (fsPath) {
                const normalizedFsPath = normalizePath(fsPath);
                if (environment) {
                    this.fsPathToEnv.set(normalizedFsPath, environment);
                } else {
                    this.fsPathToEnv.delete(normalizedFsPath);
                }
                await setPoetryForWorkspace(fsPath, environment?.environmentPath?.fsPath);
            }
        } else if (Array.isArray(scope) && scope.every((u) => u instanceof Uri)) {
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

            await setPoetryForWorkspaces(
                projects.map((p) => p.uri.fsPath),
                environment?.environmentPath?.fsPath,
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
        await this.initialize();

        if (context instanceof Uri) {
            const env = await resolvePoetryPath(context.fsPath, this.nativeFinder, this.api, this);
            if (env) {
                const _collectionEnv = this.findEnvironmentByPath(env.environmentPath.fsPath);
                if (_collectionEnv) {
                    return _collectionEnv;
                }

                this.collection.push(env);
                this._onDidChangeEnvironments.fire([{ kind: EnvironmentChangeKind.add, environment: env }]);

                return env;
            }

            return undefined;
        }
    }

    async clearCache(): Promise<void> {
        await clearPoetryCache();
    }

    private async loadEnvMap() {
        this.globalEnv = undefined;
        this.fsPathToEnv.clear();

        // Try to find a global environment
        const fsPath = await getPoetryForGlobal();

        if (fsPath) {
            this.globalEnv = this.findEnvironmentByPath(fsPath);

            // If the environment is not found, resolve the fsPath
            if (!this.globalEnv) {
                this.globalEnv = await resolvePoetryPath(fsPath, this.nativeFinder, this.api, this);

                // If the environment is resolved, add it to the collection
                if (this.globalEnv) {
                    this.collection.push(this.globalEnv);
                }
            }
        }

        if (!this.globalEnv) {
            this.globalEnv = getLatest(this.collection.filter((e) => e.group === POETRY_GLOBAL));
        }

        // Find any poetry environments that might be associated with the current projects
        // Poetry typically has a pyproject.toml file in the project root
        const pathSorted = this.collection
            .filter((e) => this.api.getPythonProject(e.environmentPath))
            .sort((a, b) => {
                if (a.environmentPath.fsPath !== b.environmentPath.fsPath) {
                    return a.environmentPath.fsPath.length - b.environmentPath.fsPath.length;
                }
                return a.environmentPath.fsPath.localeCompare(b.environmentPath.fsPath);
            });

        // Try to find workspace environments
        const projects = this.api.getPythonProjects();
        for (const project of projects) {
            const originalPath = project.uri.fsPath;
            const normalizedPath = normalizePath(originalPath);
            const env = await getPoetryForWorkspace(originalPath);

            if (env) {
                const found = this.findEnvironmentByPath(env);

                if (found) {
                    this.fsPathToEnv.set(normalizedPath, found);
                } else {
                    // If not found, resolve the poetry path
                    const resolved = await resolvePoetryPath(env, this.nativeFinder, this.api, this);

                    if (resolved) {
                        // If resolved add it to the collection
                        this.fsPathToEnv.set(normalizedPath, resolved);
                        this.collection.push(resolved);
                    } else {
                        traceError(`Failed to resolve poetry environment: ${env}`);
                    }
                }
            } else {
                // If there is not an environment already assigned by user to this project
                // then see if there is one in the collection
                if (pathSorted.length === 1) {
                    this.fsPathToEnv.set(normalizedPath, pathSorted[0]);
                } else {
                    // If there is more than one environment then we need to check if the project
                    // is a subfolder of one of the environments
                    const found = pathSorted.find((e) => {
                        const t = this.api.getPythonProject(e.environmentPath)?.uri.fsPath;
                        return t && normalizePath(t) === normalizedPath;
                    });
                    if (found) {
                        this.fsPathToEnv.set(normalizedPath, found);
                    }
                }
            }
        }
    }

    private fromEnvMap(uri: Uri): PythonEnvironment | undefined {
        // Find environment directly using the URI mapping
        const env = this.fsPathToEnv.get(normalizePath(uri.fsPath));
        if (env) {
            return env;
        }

        // Find environment using the Python project for the Uri
        const project = this.api.getPythonProject(uri);
        if (project) {
            return this.fsPathToEnv.get(normalizePath(project.uri.fsPath));
        }

        return undefined;
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

    private async getCreateProjectRoot(scope: CreateEnvironmentScope): Promise<Uri> {
        if (scope === 'global' || (Array.isArray(scope) && scope.length !== 1)) {
            throw new Error(PoetryStrings.create.singleProject);
        }
        const projectScope = Array.isArray(scope) ? scope[0] : scope;
        const project = this.api.getPythonProject(projectScope);
        return project?.uri ?? Uri.file(await findParentIfFile(projectScope.fsPath));
    }

    private async getBaseEnvironment(): Promise<PythonEnvironment> {
        const environments = await this.api.getEnvironments('global');
        const baseEnvironment = getLatest(
            environments.filter(
                (environment) =>
                    environment.version?.startsWith('3.') &&
                    !!environment.execInfo?.run?.executable &&
                    environment.envId.managerId !== this.preferredPackageManagerId,
            ),
        );
        if (!baseEnvironment) {
            throw new Error(PoetryStrings.create.noPython);
        }
        return baseEnvironment;
    }

    private parseEnvironmentPath(output: string): string {
        const environmentPath = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .reverse()
            .find((line) => path.isAbsolute(line));
        if (!environmentPath) {
            throw new Error(PoetryStrings.create.missingPath);
        }
        return environmentPath;
    }

    private getAssociatedProjectRoots(environment: PythonEnvironment): Uri[] {
        const projects = this.api.getPythonProjects();
        const mappedRoots = Array.from(this.fsPathToEnv.entries())
            .filter(([, item]) => this.sameEnvironment(item, environment))
            .map(([projectPath]) => {
                const project = projects.find((item) => normalizePath(item.uri.fsPath) === projectPath);
                return project?.uri ?? Uri.file(projectPath);
            });
        const owningProject = this.api.getPythonProject(environment.environmentPath);
        if (owningProject) {
            const owningProjectKey = normalizePath(owningProject.uri.fsPath);
            const mappedEnvironment = this.fsPathToEnv.get(owningProjectKey);
            if (
                (!mappedEnvironment || this.sameEnvironment(mappedEnvironment, environment)) &&
                !mappedRoots.some((root) => normalizePath(root.fsPath) === owningProjectKey)
            ) {
                mappedRoots.push(owningProject.uri);
            }
        }
        return mappedRoots;
    }

    private async findOwningProjectRoot(
        environment: PythonEnvironment,
        projectRoots: Uri[],
        token: CancellationToken,
    ): Promise<Uri> {
        for (const projectRoot of projectRoots) {
            try {
                const output = await runPoetry(
                    ['--no-ansi', 'env', 'info', '--path'],
                    projectRoot.fsPath,
                    this.log,
                    token,
                );
                const environmentPath = this.parseEnvironmentPath(output);
                if (normalizePath(environmentPath) === normalizePath(environment.environmentPath.fsPath)) {
                    return projectRoot;
                }
            } catch (error) {
                if (error instanceof CancellationError) {
                    throw error;
                }
                traceInfo(`Poetry project at ${projectRoot.fsPath} does not own the environment being removed`);
            }
        }
        throw new Error(PoetryStrings.remove.noProject(environment.environmentPath.fsPath));
    }

    private sameEnvironment(left: PythonEnvironment, right: PythonEnvironment): boolean {
        return normalizePath(left.environmentPath.fsPath) === normalizePath(right.environmentPath.fsPath);
    }
}
