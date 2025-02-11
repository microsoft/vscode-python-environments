import { ProgressLocation, Uri, LogOutputChannel, EventEmitter, MarkdownString, ThemeIcon } from 'vscode';
import {
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
import {
    clearVenvCache,
    createPythonVenv,
    findVirtualEnvironments,
    getGlobalVenvLocation,
    getVenvForGlobal,
    getVenvForWorkspace,
    removeVenv,
    resolveVenvPythonEnvironmentPath,
    setVenvForGlobal,
    setVenvForWorkspace,
    setVenvForWorkspaces,
} from './venvUtils';
import * as path from 'path';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { PYTHON_EXTENSION_ID } from '../../common/constants';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { getLatest, sortEnvironments } from '../common/utils';
import { withProgress } from '../../common/window.apis';
import { VenvManagerStrings } from '../../common/localize';

export class VenvManager implements EnvironmentManager {
    private collection: PythonEnvironment[] = [];
    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    readonly name: string;
    readonly displayName?: string | undefined;
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
    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }

        this._initialized = createDeferred();

        try {
            await this.internalRefresh(undefined, false, VenvManagerStrings.venvInitialize);
        } finally {
            this._initialized.resolve();
        }
    }

    async create(scope: CreateEnvironmentScope): Promise<PythonEnvironment | undefined> {
        let isGlobal = scope === 'global';
        if (Array.isArray(scope) && scope.length > 1) {
            isGlobal = true;
        }
        let uri: Uri | undefined = undefined;
        if (isGlobal) {
            uri = await getGlobalVenvLocation();
        } else {
            uri = scope instanceof Uri ? scope : (scope as Uri[])[0];
        }

        if (!uri) {
            return;
        }

        const venvRoot: Uri = uri;
        const globals = await this.baseManager.getEnvironments('global');
        const environment = await createPythonVenv(this.nativeFinder, this.api, this.log, this, globals, venvRoot);
        if (environment) {
            this.addEnvironment(environment, true);
        }
        return environment;
    }

    async remove(environment: PythonEnvironment): Promise<void> {
        await removeVenv(environment, this.log);
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
    }

    private updateCollection(environment: PythonEnvironment): void {
        this.collection = this.collection.filter(
            (e) => e.environmentPath.fsPath !== environment.environmentPath.fsPath,
        );
    }

    private updateFsPathToEnv(environment: PythonEnvironment): Uri[] {
        const changed: Uri[] = [];
        this.fsPathToEnv.forEach((env, uri) => {
            if (env.environmentPath.fsPath === environment.environmentPath.fsPath) {
                this.fsPathToEnv.delete(uri);
                changed.push(Uri.file(uri));
            }
        });
        return changed;
    }

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        return this.internalRefresh(scope, true, VenvManagerStrings.venvRefreshing);
    }

    private async internalRefresh(scope: RefreshEnvironmentsScope, hardRefresh: boolean, title: string): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title,
            },
            async () => {
                const discard = this.collection.map((env) => ({
                    kind: EnvironmentChangeKind.remove,
                    environment: env,
                }));

                this.collection = await findVirtualEnvironments(
                    hardRefresh,
                    this.nativeFinder,
                    this.api,
                    this.log,
                    this,
                    scope ? [scope] : this.api.getPythonProjects().map((p) => p.uri),
                );
                await this.loadEnvMap();

                const added = this.collection.map((env) => ({ environment: env, kind: EnvironmentChangeKind.add }));
                this._onDidChangeEnvironments.fire([...discard, ...added]);
            },
        );
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            return Array.from(this.collection);
        }
        if (!(scope instanceof Uri)) {
            return [];
        }

        const env = this.fsPathToEnv.get(scope.fsPath);
        return env ? [env] : [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        await this.initialize();

        if (!scope) {
            // `undefined` for venv scenario return the global environment.
            return this.globalEnv;
        }

        const project = this.api.getPythonProject(scope);
        if (!project) {
            return this.globalEnv;
        }

        let env = this.fsPathToEnv.get(project.uri.fsPath);
        if (!env) {
            env = this.findEnvironmentByPath(project.uri.fsPath);
        }

        return env ?? this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
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

            const before = this.fsPathToEnv.get(pw.uri.fsPath);
            if (environment) {
                this.fsPathToEnv.set(pw.uri.fsPath, environment);
            } else {
                this.fsPathToEnv.delete(pw.uri.fsPath);
            }
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
                before.set(p.uri.fsPath, this.fsPathToEnv.get(p.uri.fsPath));
                if (environment) {
                    this.fsPathToEnv.set(p.uri.fsPath, environment);
                } else {
                    this.fsPathToEnv.delete(p.uri.fsPath);
                }
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
                // This is just like finding a new environment or creating a new one.
                // Add it to collection, and trigger the added event.
                this.addEnvironment(resolved, true);

                // We should only return the resolved env if it is a venv.
                // Fall through an return undefined if it is not a venv
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
            this.globalEnv = getLatest(globals);
        }
    }

    private async loadEnvMap() {
        const globals = await this.baseManager.getEnvironments('global');
        await this.loadGlobalEnv(globals);

        this.fsPathToEnv.clear();

        const sorted = sortEnvironments(this.collection);
        const paths = this.api.getPythonProjects().map((p) => path.normalize(p.uri.fsPath));
        const events: (() => void)[] = [];
        for (const p of paths) {
            const env = await getVenvForWorkspace(p);

            if (env) {
                const found = this.findEnvironmentByPath(env, sorted) ?? this.findEnvironmentByPath(env, globals);
                const previous = this.fsPathToEnv.get(p);
                const pw = this.api.getPythonProject(Uri.file(p));
                if (found) {
                    this.fsPathToEnv.set(p, found);
                    if (pw && previous?.envId.id !== found.envId.id) {
                        events.push(() =>
                            this._onDidChangeEnvironment.fire({ uri: pw.uri, old: undefined, new: found }),
                        );
                    }
                } else {
                    const resolved = await resolveVenvPythonEnvironmentPath(
                        env,
                        this.nativeFinder,
                        this.api,
                        this,
                        this.baseManager,
                    );
                    if (resolved) {
                        // If resolved add it to the collection
                        this.fsPathToEnv.set(p, resolved);
                        this.addEnvironment(resolved, false);
                        if (pw && previous?.envId.id !== resolved.envId.id) {
                            events.push(() =>
                                this._onDidChangeEnvironment.fire({ uri: pw.uri, old: undefined, new: resolved }),
                            );
                        }
                    } else {
                        this.log.error(`Failed to resolve python environment: ${env}`);
                    }
                }
            } else {
                // There is NO selected venv, then try and choose the venv that is in the workspace.
                if (sorted.length === 1) {
                    this.fsPathToEnv.set(p, sorted[0]);
                } else {
                    // These are sorted by version and by path length. The assumption is that the user would want to pick
                    // latest version and the one that is closest to the workspace.
                    const found = sorted.find((e) => {
                        const t = this.api.getPythonProject(e.environmentPath)?.uri.fsPath;
                        return t && path.normalize(t) === p;
                    });
                    if (found) {
                        this.fsPathToEnv.set(p, found);
                    }
                }
            }
        }

        events.forEach((e) => e());
    }

    private findEnvironmentByPath(fsPath: string, collection?: PythonEnvironment[]): PythonEnvironment | undefined {
        const normalized = path.normalize(fsPath);
        const envs = collection ?? this.collection;
        return envs.find((e) => {
            const n = path.normalize(e.environmentPath.fsPath);
            return n === normalized || path.dirname(n) === normalized || path.dirname(path.dirname(n)) === normalized;
        });
    }

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
