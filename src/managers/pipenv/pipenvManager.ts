import { Disposable, EventEmitter, MarkdownString, ProgressLocation, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    PythonEnvironment,
    PythonEnvironmentApi,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { PipenvStrings } from '../../common/localize';
import { traceError, traceInfo } from '../../common/logging';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { withProgress } from '../../common/window.apis';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { getLatest } from '../common/utils';
import {
    clearPipenvCache,
    getPipenvForGlobal,
    PIPENV_GLOBAL,
    refreshPipenv,
    resolvePipenvPath,
    setPipenvForGlobal,
    setPipenvForWorkspace,
    setPipenvForWorkspaces,
} from './pipenvUtils';

export class PipenvManager implements EnvironmentManager, Disposable {
    private collection: PythonEnvironment[] = [];
    private fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    constructor(private readonly nativeFinder: NativePythonFinder, private readonly api: PythonEnvironmentApi) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.description = PipenvStrings.pipenvManager;
    }

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly description: string;

    get tooltip(): string | MarkdownString | undefined {
        return this.description;
    }

    private refreshPromise: Deferred<PythonEnvironment[]> | undefined;

    dispose(): void {
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
    }

    async refresh(_scope?: RefreshEnvironmentsScope): Promise<void> {
        const hardRefresh = false; // We'll use false for now, could be enhanced later
        const refreshPromise = createDeferred<PythonEnvironment[]>();
        this.refreshPromise = refreshPromise;

        try {
            const environments = await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: PipenvStrings.pipenvRefreshing,
                },
                async () => {
                    const envs = await refreshPipenv(hardRefresh, this.nativeFinder, this.api, this);

                    // Clear cache if requested
                    if (hardRefresh) {
                        await clearPipenvCache();
                    }

                    return envs;
                },
            );

            this.collection = environments;
            this.fsPathToEnv.clear();
            environments.forEach((env) => {
                if (env.environmentPath) {
                    this.fsPathToEnv.set(env.environmentPath.fsPath, env);
                }
            });

            this._onDidChangeEnvironments.fire(
                environments.map((env) => ({
                    kind: EnvironmentChangeKind.add,
                    environment: env,
                }))
            );

            refreshPromise.resolve(environments);
        } catch (ex) {
            traceError('Failed to refresh pipenv environments', ex);
            refreshPromise.reject(ex);
        }
    }

    async getEnvironments(scope?: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        if (this.collection.length === 0 && this.refreshPromise === undefined) {
            await this.refresh();
        }

        if (this.refreshPromise) {
            await this.refreshPromise.promise;
        }

        const environments = this.collection.slice();

        if (!scope || scope === 'all') {
            return environments;
        }

        if (scope === 'global') {
            return environments.filter((env) => env.group === PIPENV_GLOBAL);
        }

        if (scope instanceof Uri) {
            const projectPath = scope.fsPath;
            return environments.filter((env) => {
                if (env.environmentPath) {
                    const envPath = env.environmentPath.fsPath;
                    return envPath.includes(projectPath) || projectPath.includes(envPath);
                }
                return false;
            });
        }

        return environments;
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        if (this.collection.length === 0 && this.refreshPromise === undefined) {
            await this.refresh();
        }

        if (this.refreshPromise) {
            await this.refreshPromise.promise;
        }

        if (scope instanceof Uri) {
            let env = this.fsPathToEnv.get(scope.fsPath);
            if (env) {
                return env;
            }

            // Try to find by project path
            const projectPath = scope.fsPath;
            return this.collection.find((env) => {
                if (env.environmentPath) {
                    const envPath = env.environmentPath.fsPath;
                    return envPath.includes(projectPath) || projectPath.includes(envPath);
                }
                return false;
            });
        }

        // Global scope - return the global environment if set
        return this.globalEnv || (await getPipenvForGlobal())
            ? getLatest(this.collection.filter((env) => env.group === PIPENV_GLOBAL))
            : undefined;
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        const environmentPath = context;
        const fsPath = environmentPath.fsPath;

        // Check if we already have it in our collection
        let env = this.fsPathToEnv.get(fsPath);
        if (env) {
            return env;
        }

        // Try to resolve using the native finder
        try {
            env = await resolvePipenvPath(environmentPath, this.nativeFinder, this.api);
            if (env) {
                this.fsPathToEnv.set(fsPath, env);
                return env;
            }
        } catch (ex) {
            traceError(`Error resolving pipenv environment: ${fsPath}`, ex);
        }

        return undefined;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (scope === undefined) {
            // Global setting
            const envPath = environment?.environmentPath?.fsPath;
            await setPipenvForGlobal(envPath);
            this.globalEnv = environment;
            traceInfo(`Set global pipenv environment: ${envPath || 'none'}`);
        } else if (scope instanceof Uri) {
            const projectPath = scope.fsPath;
            const envPath = environment?.environmentPath?.fsPath;

            if (envPath) {
                await setPipenvForWorkspace(projectPath, envPath);
                traceInfo(`Set pipenv environment for project ${projectPath}: ${envPath}`);
            } else {
                await setPipenvForWorkspace(projectPath, undefined);
                traceInfo(`Cleared pipenv environment for project ${projectPath}`);
            }
        } else if (Array.isArray(scope)) {
            // Multiple projects
            const envPath = environment?.environmentPath?.fsPath;
            const projectPaths = scope.map(uri => uri.fsPath);
            await setPipenvForWorkspaces(projectPaths, envPath);
            traceInfo(`Set pipenv environment for projects ${projectPaths.join(', ')}: ${envPath || 'none'}`);
        }

        this._onDidChangeEnvironment.fire({
            uri: scope instanceof Uri ? scope : undefined,
            old: undefined,
            new: environment,
        });
    }

    // Pipenv doesn't support creation or removal through this interface
    // Users should use `pipenv install` and `pipenv --rm` directly

    // Pipenv doesn't support creation or removal through this interface
    // Users should use `pipenv install` and `pipenv --rm` directly
}