import { EventEmitter, MarkdownString, ProgressLocation, Uri } from 'vscode';
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
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { traceInfo } from '../../common/logging';
import { PipenvStrings } from '../../common/localize';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { withProgress } from '../../common/window.apis';
import { NativePythonFinder } from '../common/nativePythonFinder';
import {
    clearPipenvCache,
    getPipenvForGlobal,
    getPipenvForWorkspace,
    refreshPipenv,
    resolvePipenvPath,
    setPipenvForGlobal,
    setPipenvForWorkspace,
    setPipenvForWorkspaces,
} from './pipenvUtils';

export class PipenvManager implements EnvironmentManager {
    private collection: PythonEnvironment[] = [];
    private fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly description?: string;
    public readonly tooltip: string | MarkdownString;
    public readonly iconPath?: IconPath;

    private _initialized: Deferred<void> | undefined;

    constructor(public readonly nativeFinder: NativePythonFinder, public readonly api: PythonEnvironmentApi) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.tooltip = new MarkdownString(PipenvStrings.pipenvManager, true);
    }

    public dispose() {
        this.collection = [];
        this.fsPathToEnv.clear();
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
    }

    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }

        this._initialized = createDeferred<void>();

        try {
            await this.refresh(undefined);
            this._initialized.resolve();
        } catch (ex) {
            this._initialized.reject(ex);
        }
    }

    private async loadEnvMap() {
        // Map workspace folders to selected environments
        const projects = this.api.getPythonProjects();
        for (const project of projects) {
            const selectedPath = await getPipenvForWorkspace(project.uri.fsPath);
            if (selectedPath) {
                const env = this.collection.find((e) => e.environmentPath.fsPath === selectedPath);
                if (env) {
                    this.fsPathToEnv.set(project.uri.fsPath, env);
                }
            }
        }

        // Load global environment selection
        const globalPath = await getPipenvForGlobal();
        if (globalPath) {
            this.globalEnv = this.collection.find((e) => e.environmentPath.fsPath === globalPath);
        }
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            return this.collection;
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            if (project) {
                const env = this.fsPathToEnv.get(project.uri.fsPath);
                return env ? [env] : [];
            }
        }

        return [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        await this.initialize();

        if (scope === undefined) {
            return this.globalEnv;
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            if (project) {
                return this.fsPathToEnv.get(project.uri.fsPath);
            }
        }

        return undefined;
    }

    async set(scope: SetEnvironmentScope, environment: PythonEnvironment | undefined): Promise<void> {
        await this.initialize();

        if (scope === undefined) {
            // Global selection
            this.globalEnv = environment;
            await setPipenvForGlobal(environment?.environmentPath.fsPath);
            this._onDidChangeEnvironment.fire({
                old: this.globalEnv,
                new: environment,
                uri: undefined,
            });
        } else if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            if (project) {
                const old = this.fsPathToEnv.get(project.uri.fsPath);
                if (environment) {
                    this.fsPathToEnv.set(project.uri.fsPath, environment);
                } else {
                    this.fsPathToEnv.delete(project.uri.fsPath);
                }
                await setPipenvForWorkspace(project.uri.fsPath, environment?.environmentPath.fsPath);
                this._onDidChangeEnvironment.fire({
                    old,
                    new: environment,
                    uri: scope,
                });
            }
        } else if (Array.isArray(scope)) {
            // Multiple workspace folders
            const fsPaths = scope.map((uri) => {
                const project = this.api.getPythonProject(uri);
                return project?.uri.fsPath;
            }).filter((p): p is string => p !== undefined);

            if (fsPaths.length > 0) {
                for (const fsPath of fsPaths) {
                    if (environment) {
                        this.fsPathToEnv.set(fsPath, environment);
                    } else {
                        this.fsPathToEnv.delete(fsPath);
                    }
                }
                await setPipenvForWorkspaces(fsPaths, environment?.environmentPath.fsPath);

                for (const uri of scope) {
                    const project = this.api.getPythonProject(uri);
                    if (project) {
                        this._onDidChangeEnvironment.fire({
                            old: undefined, // We don't track old values for bulk operations
                            new: environment,
                            uri,
                        });
                    }
                }
            }
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        await this.initialize();
        return resolvePipenvPath(context.fsPath, this.nativeFinder, this.api, this);
    }

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        if (scope === undefined) {
            await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: PipenvStrings.pipenvRefreshing,
                },
                async () => {
                    traceInfo('Refreshing Pipenv Environments');
                    const oldCollection = [...this.collection];

                    // Refresh the collection
                    this.collection = await refreshPipenv(true, this.nativeFinder, this.api, this);

                    // Reload the environment mappings
                    await this.loadEnvMap();

                    // Emit change events
                    const changes: DidChangeEnvironmentsEventArgs = [];

                    // Check for removed environments
                    oldCollection.forEach((oldEnv) => {
                        if (!this.collection.find((newEnv) => newEnv.envId.id === oldEnv.envId.id)) {
                            changes.push({ environment: oldEnv, kind: EnvironmentChangeKind.remove });
                        }
                    });

                    // Check for added environments
                    this.collection.forEach((newEnv) => {
                        if (!oldCollection.find((oldEnv) => oldEnv.envId.id === newEnv.envId.id)) {
                            changes.push({ environment: newEnv, kind: EnvironmentChangeKind.add });
                        }
                    });

                    if (changes.length > 0) {
                        this._onDidChangeEnvironments.fire(changes);
                    }
                },
            );
        }
    }

    async clearCache?(): Promise<void> {
        await clearPipenvCache();
        this.collection = [];
        this.fsPathToEnv.clear();
        this.globalEnv = undefined;
        this._initialized = undefined;
    }
}