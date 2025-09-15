import * as path from 'path';
import { Disposable, EventEmitter, MarkdownString, ProgressLocation, Uri } from 'vscode';
import {
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
import { PipenvStrings } from '../../common/localize';
import { traceError, traceInfo } from '../../common/logging';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { withProgress } from '../../common/window.apis';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { getLatest } from '../common/utils';
import {
    clearPipenvCache,
    getPipenvForGlobal,
    getPipenvForWorkspace,
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
        this.id = 'ms-python.python:pipenv';
        this.description = PipenvStrings.pipenvManager;
        this.supportsCreate = false;
        this.supportsRemove = false;
    }

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly id: string;
    public readonly description: string;
    public readonly supportsCreate: boolean;
    public readonly supportsRemove: boolean;

    public get icon(): IconPath {
        return {
            light: Uri.file(path.join(__dirname, '..', '..', '..', 'images', 'pipenv-light.svg')),
            dark: Uri.file(path.join(__dirname, '..', '..', '..', 'images', 'pipenv-dark.svg')),
        };
    }

    get tooltip(): string | MarkdownString | undefined {
        return this.description;
    }

    private refreshPromise: Deferred<PythonEnvironment[]> | undefined;

    dispose(): void {
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
    }

    async refresh(scope?: RefreshEnvironmentsScope): Promise<void> {
        const hardRefresh = scope?.hardRefresh ?? false;
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

            this._onDidChangeEnvironments.fire({
                manager: this,
                type: EnvironmentChangeKind.update,
                environments,
            });

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

        if (scope?.project) {
            const projectPath = typeof scope.project === 'string' ? scope.project : scope.project.fsPath;
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

    async getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const environmentPath = scope.environment;
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

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return this.getEnvironment({ environment: context.interpreterPath });
    }

    async set(scope: SetEnvironmentScope): Promise<void> {
        const { environment, project } = scope;

        if (project) {
            const projectPath = typeof project === 'string' ? project : project.fsPath;
            const envPath = environment?.environmentPath?.fsPath;

            if (envPath) {
                await setPipenvForWorkspace(projectPath, envPath);
                traceInfo(`Set pipenv environment for project ${projectPath}: ${envPath}`);
            } else {
                await setPipenvForWorkspace(projectPath, undefined);
                traceInfo(`Cleared pipenv environment for project ${projectPath}`);
            }
        } else {
            // Global setting
            const envPath = environment?.environmentPath?.fsPath;
            await setPipenvForGlobal(envPath);
            this.globalEnv = environment;
            traceInfo(`Set global pipenv environment: ${envPath || 'none'}`);
        }

        this._onDidChangeEnvironment.fire({
            manager: this,
            type: EnvironmentChangeKind.update,
            environment,
            old: undefined,
        });
    }

    async create(): Promise<PythonEnvironment | undefined> {
        // Pipenv doesn't support creation through this interface
        // Users should use `pipenv install` directly in their project
        return undefined;
    }

    async remove(): Promise<void> {
        // Pipenv doesn't support removal through this interface  
        // Users should use `pipenv --rm` directly in their project
    }

    async getPreferred(projects: PythonProject[]): Promise<PythonEnvironment | undefined> {
        if (projects.length === 0) {
            return this.globalEnv || (await getPipenvForGlobal())
                ? getLatest(this.collection.filter((env) => env.group === PIPENV_GLOBAL))
                : undefined;
        }

        const project = projects[0];
        const projectPath = typeof project === 'string' ? project : project.fsPath;

        // Check if we have a specific pipenv environment for this project
        const preferredPath = await getPipenvForWorkspace(projectPath);
        if (preferredPath) {
            const env = this.fsPathToEnv.get(preferredPath);
            if (env) {
                return env;
            }
        }

        // Look for pipenv environment in project directory
        const projectEnvs = this.collection.filter((env) => {
            if (env.environmentPath) {
                const envPath = env.environmentPath.fsPath;
                return envPath.includes(projectPath);
            }
            return false;
        });

        return getLatest(projectEnvs);
    }
}