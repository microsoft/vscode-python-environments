import * as path from 'path';
import { EventEmitter, LogOutputChannel, MarkdownString, ProgressLocation, Uri, window } from 'vscode';
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
import {
    clearSystemEnvCache,
    getSystemEnvForGlobal,
    getSystemEnvForWorkspace,
    refreshPythons,
    resolveSystemPythonEnvironmentPath,
    setSystemEnvForGlobal,
    setSystemEnvForWorkspace,
} from './utils';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { getLatest } from '../common/utils';
import { EXTENSION_ROOT_DIR } from '../../common/constants';

export class SysPythonManager implements EnvironmentManager {
    private collection: PythonEnvironment[] = [];
    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly description: string;
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
        this.description = 'Manages Global python installs';
        this.tooltip = new MarkdownString('$(globe) Python Environment Manager', true);
        this.iconPath = {
            light: Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', 'light_mode_icon.svg')),
            dark: Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', 'dark_mode_icon.svg')),
        };
    }

    private _initialized: Deferred<void> | undefined;
    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }

        this._initialized = createDeferred();

        await this.internalRefresh(false, 'Discovering Python environments');

        this._initialized.resolve();
    }

    refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        return this.internalRefresh(true, 'Refreshing Python environments');
    }

    private async internalRefresh(hardRefresh: boolean, title: string) {
        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title,
            },
            async () => {
                const discard = this.collection.map((c) => c);

                this.collection = await refreshPythons(hardRefresh, this.nativeFinder, this.api, this.log, this);
                await this.loadEnvMap();

                const args = [
                    ...discard.map((e) => ({ environment: e, kind: EnvironmentChangeKind.remove })),
                    ...this.collection.map((e) => ({ environment: e, kind: EnvironmentChangeKind.add })),
                ];

                this._onDidChangeEnvironments.fire(args);
            },
        );
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all' || scope === 'global') {
            return Array.from(this.collection);
        }

        if (scope instanceof Uri) {
            const env = this.fsPathToEnv.get(scope.fsPath);
            if (env) {
                return [env];
            }
        }

        return [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        await this.initialize();

        if (scope instanceof Uri) {
            return this.fromEnvMap(scope) ?? this.globalEnv;
        }

        return this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (scope instanceof Uri) {
            const pw = this.api.getPythonProject(scope);
            if (pw) {
                if (environment) {
                    this.fsPathToEnv.set(pw.uri.fsPath, environment);
                    await setSystemEnvForWorkspace(pw.uri.fsPath, environment.environmentPath.fsPath);
                } else {
                    this.fsPathToEnv.delete(pw.uri.fsPath);
                    await setSystemEnvForWorkspace(pw.uri.fsPath, undefined);
                }
                return;
            }
            this.log.warn(
                `Unable to set environment for ${scope.fsPath}: Not a python project, folder or PEP723 script.`,
                this.api.getPythonProjects().map((p) => p.uri.fsPath),
            );
        }

        if (scope === undefined) {
            this.globalEnv = environment ?? getLatest(this.collection);
            if (environment) {
                await setSystemEnvForGlobal(environment.environmentPath.fsPath);
            }
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
            this.collection.push(resolved);
            this._onDidChangeEnvironments.fire([{ environment: resolved, kind: EnvironmentChangeKind.add }]);
        }

        return resolved;
    }

    async clearCache(): Promise<void> {
        await clearSystemEnvCache();
    }

    private findEnvironmentByPath(fsPath: string): PythonEnvironment | undefined {
        const normalized = path.normalize(fsPath);
        return this.collection.find((e) => {
            const n = path.normalize(e.environmentPath.fsPath);
            return n === normalized || path.dirname(n) === normalized || path.dirname(path.dirname(n)) === normalized;
        });
    }

    private fromEnvMap(uri: Uri): PythonEnvironment | undefined {
        // Find environment directly using the URI mapping
        const env = this.fsPathToEnv.get(uri.fsPath);
        if (env) {
            return env;
        }

        // Find environment using the Python project for the Uri
        const project = this.api.getPythonProject(uri);
        if (project) {
            return this.fsPathToEnv.get(project.uri.fsPath);
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
                this.globalEnv = await resolveSystemPythonEnvironmentPath(fsPath, this.nativeFinder, this.api, this);

                // If the environment is resolved, add it to the collection
                if (this.globalEnv) {
                    this.collection.push(this.globalEnv);
                }
            }
        }

        // If a global environment is still not set, try using the latest environment
        if (!this.globalEnv) {
            this.globalEnv = getLatest(this.collection);
        }

        // Try to find workspace environments
        const paths = this.api.getPythonProjects().map((p) => p.uri.fsPath);

        // Iterate over each path
        for (const p of paths) {
            const env = await getSystemEnvForWorkspace(p);

            if (env) {
                const found = this.findEnvironmentByPath(env);

                if (found) {
                    this.fsPathToEnv.set(p, found);
                } else {
                    // If not found, resolve the path.
                    const resolved = await resolveSystemPythonEnvironmentPath(env, this.nativeFinder, this.api, this);

                    if (resolved) {
                        // If resolved add it to the collection.
                        this.fsPathToEnv.set(p, resolved);
                        this.collection.push(resolved);
                    } else {
                        this.log.error(`Failed to resolve python environment: ${env}`);
                    }
                }
            }
        }
    }
}
