import type { Pep440Version } from '@renovatebot/pep440';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import {
    CancellationError,
    CancellationToken,
    Event,
    EventEmitter,
    FileType,
    l10n,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
    Uri,
} from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import {
    DidChangePackagesEventArgs,
    GetPackagesOptions,
    IconPath,
    Package,
    PackageManagementOptions,
    PackageManager,
    PackageVersionLookupNotSupportedError,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../api';
import { Capabilities, PackageCapability, PackageManagerCapability, Support } from '../../capabilities';
import { showErrorMessage, showInputBox, withProgress } from '../../common/window.apis';
import * as workspaceFs from '../../common/workspace.fs.apis';
import {
    PackageToolSupport,
    PythonToolError,
    pythonToolSupport,
    throwIfCancelled,
    waitForToolRead,
} from '../../internal/pythonToolSupport';
import { PackageManagerRequiresProjectError } from '../common/errors';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { parsePackageSpecs } from '../common/packageUtils';
import {
    PoetryAddCommand,
    PoetryRemoveCommand,
    PoetryShowCommand,
    PoetryShowTopLevelCommand,
    PoetryVersionCommand,
} from './commands/index';
import { runPoetry } from './commands/runPoetry';
import { PoetryManager } from './poetryManager';
import { getPoetry } from './poetryUtils';

const pendingPoetryEnvironmentMismatchNotifications = new Set<string>();

interface PoetryTarget {
    readonly canonical?: string;
    readonly identity?: string;
    readonly reported: string;
}

interface VerifiedPoetryEnvironment {
    readonly cacheKey: string;
    readonly env: NodeJS.ProcessEnv;
}

interface ResolvedEnvironment {
    readonly canonical: string;
    readonly identity: string;
}

interface PoetryPackageManagerSharedState {
    readonly environmentOperations: Map<string, Promise<void>>;
    readonly installedPackages: Map<string, Package[]>;
}

function isPoetryEnvironmentMismatch(error: unknown): error is PythonToolError {
    return error instanceof PythonToolError && error.code === 'ENVIRONMENT_MISMATCH';
}

async function resolveEnvironmentEntry(envPath: string): Promise<ResolvedEnvironment> {
    const canonical = await fsapi.realpath(envPath);
    const stat = await fsapi.stat(canonical, { bigint: true });
    const identity =
        stat.ino !== BigInt(0)
            ? `${stat.dev.toString()}:${stat.ino.toString()}`
            : path.resolve(canonical);
    return { canonical, identity };
}

export class PoetryPackageManager implements PackageManager, Disposable {
    readonly capabilities: Capabilities<PackageManagerCapability> = {
        [PackageCapability.List]: async () => this.checkProjectSupport(),
        [PackageCapability.ListDirect]: async () => this.checkProjectSupport(),
        [PackageCapability.Install]: async () => this.checkProjectSupport(),
        [PackageCapability.Uninstall]: async () => this.checkProjectSupport(),
        [PackageCapability.FetchAvailableVersions]: async () => ({
            supported: false,
            reason: l10n.t('Poetry package version lookup is not supported by this extension.'),
        }),
        [PackageCapability.Upgrade]: async () => ({
            supported: false,
            reason: l10n.t('Poetry package management does not support the upgrade option.'),
        }),
    };

    private checkProjectSupport(): Support {
        if (!this.project) {
            return { supported: false, reason: l10n.t('Poetry package management requires a project-bound manager.') };
        }
        return { supported: true };
    }

    private readonly packagesChangedEmitter = new EventEmitter<DidChangePackagesEventArgs>();
    readonly onDidChangePackages: Event<DidChangePackagesEventArgs> = this.packagesChangedEmitter.event;

    private readonly packages = new Map<string, Package[]>();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly poetryManager: PoetryManager,
        private readonly project?: PythonProject,
        private readonly sharedState: PoetryPackageManagerSharedState = {
            environmentOperations: new Map(),
            installedPackages: new Map(),
        },
        private readonly ownsSharedState = true,
    ) {
        this.name = 'poetry';
        this.displayName = 'Poetry';
        this.description = 'This package manager for Python uses Poetry for package management.';
        this.tooltip = new MarkdownString('This package manager for Python uses `poetry` for package management.');
        this.iconPath = new ThemeIcon('package');
    }
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
    readonly iconPath?: IconPath;

    /**
     * Creates a Poetry package manager bound to a Python project.
     *
     * @param project The project whose working directory Poetry commands should use.
     * @returns A Poetry package manager scoped to the project.
     */
    createForProject(project: PythonProject): PoetryPackageManager {
        return new PoetryPackageManager(
            this.api,
            this.log,
            this.poetryManager,
            project,
            this.sharedState,
            false,
        );
    }

    readonly [pythonToolSupport]: PackageToolSupport = {
        manage: async (environment, options, token, scope) => {
            await this.manage(environment, { ...options, runHeadless: true }, token, scope);
        },
        getPackages: (environment, token, scope) =>
            this.enqueueEnvironmentOperation(environment, token, async () => {
                const verified = await this.verifyEnvironment(environment, scope.fsPath, token, true);
                const packages = await this.fetchInstalledPackagesForTools(environment, token, scope, verified.env);
                this.sharedState.installedPackages.set(verified.cacheKey, packages);
                return packages;
            }),
    };

    private async resolvePoetryTarget(
        cwd: string,
        token?: CancellationToken,
        toolExecution = false,
        env?: NodeJS.ProcessEnv,
    ): Promise<PoetryTarget> {
        const output = await runPoetry(
            ['--no-ansi', 'env', 'info', '--path'],
            cwd,
            this.log,
            token,
            toolExecution,
            env,
        );
        throwIfCancelled(token);
        const reported = output.trim();
        const lines = reported.split(/\r?\n/).filter((line) => line.length > 0);
        const target = lines.length === 1 ? lines[0] : undefined;
        if (!target || !path.isAbsolute(target)) {
            return { reported };
        }
        try {
            const resolved = await resolveEnvironmentEntry(target);
            return { ...resolved, reported: target };
        } catch (error) {
            this.log.error('Failed to resolve the Poetry target environment', error);
            return { reported: target };
        }
    }

    private async resolveSelectedEnvironment(environment: PythonEnvironment): Promise<ResolvedEnvironment | undefined> {
        if (!environment.sysPrefix || !path.isAbsolute(environment.sysPrefix)) {
            return undefined;
        }
        try {
            return await resolveEnvironmentEntry(environment.sysPrefix);
        } catch (error) {
            this.log.error('Failed to resolve the selected Python environment', error);
            return undefined;
        }
    }

    private async verifyEnvironment(
        environment: PythonEnvironment,
        cwd: string,
        token?: CancellationToken,
        toolExecution = false,
    ): Promise<VerifiedPoetryEnvironment> {
        throwIfCancelled(token);
        const operationEnv: NodeJS.ProcessEnv = toolExecution ? {} : { ...process.env };
        const target = await this.resolvePoetryTarget(cwd, token, toolExecution, operationEnv);
        const selected = await this.resolveSelectedEnvironment(environment);
        throwIfCancelled(token);
        if (!target.canonical || !target.identity || !selected || target.identity !== selected.identity) {
            this.deletePackageCaches(environment, selected?.identity);
            throw this.createEnvironmentMismatch(environment, cwd, target.reported);
        }

        const env = { ...operationEnv, VIRTUAL_ENV: target.canonical };
        const pinnedTarget = await this.resolvePoetryTarget(cwd, token, toolExecution, env);
        throwIfCancelled(token);
        if (
            !pinnedTarget.canonical ||
            !pinnedTarget.identity ||
            pinnedTarget.identity !== target.identity
        ) {
            this.deletePackageCaches(environment, selected.identity);
            throw this.createEnvironmentMismatch(environment, cwd, pinnedTarget.reported);
        }

        return { cacheKey: target.identity, env };
    }

    private createEnvironmentMismatch(
        environment: PythonEnvironment,
        cwd: string,
        reportedTarget: string,
    ): PythonToolError {
        return new PythonToolError(
            'ENVIRONMENT_MISMATCH',
            l10n.t(
                "Poetry for {0} targets {1}, not the selected environment {2}. Select this project's Poetry environment or choose a compatible package manager before querying or changing packages.",
                cwd,
                reportedTarget || l10n.t('no environment'),
                environment.sysPrefix || l10n.t('no environment'),
            ),
            environment,
        );
    }

    private deletePackageCaches(environment: PythonEnvironment, installedCacheKey?: string): void {
        this.packages.delete(environment.envId.id);
        if (installedCacheKey) {
            this.sharedState.installedPackages.delete(installedCacheKey);
        } else {
            this.sharedState.installedPackages.clear();
        }
    }

    private async enqueueEnvironmentOperation<T>(
        environment: PythonEnvironment,
        token: CancellationToken | undefined,
        operation: () => Promise<T>,
    ): Promise<T> {
        throwIfCancelled(token);
        const selected = await this.resolveSelectedEnvironment(environment);
        throwIfCancelled(token);
        const key = selected?.identity ?? `environment:${environment.envId.id}`;
        const previous = this.sharedState.environmentOperations.get(key) ?? Promise.resolve();
        const waitForPrevious = token ? waitForToolRead(previous, token, null) : previous;
        const result = waitForPrevious.then(async () => {
            throwIfCancelled(token);
            return operation();
        });
        const tail = previous.then(
            () => result.then(() => undefined, () => undefined),
            () => result.then(() => undefined, () => undefined),
        );
        this.sharedState.environmentOperations.set(key, tail);
        void tail.finally(() => {
            if (this.sharedState.environmentOperations.get(key) === tail) {
                this.sharedState.environmentOperations.delete(key);
            }
        });
        return result;
    }

    private async fetchInstalledPackagesForTools(
        environment: PythonEnvironment,
        token: CancellationToken,
        scope: Uri,
        env: NodeJS.ProcessEnv,
    ): Promise<Package[]> {
        // poetry show describes the lockfile, not the installed distributions.
        const output = await runPoetry(
            ['run', 'pip', 'list', '--format=json', '--disable-pip-version-check'],
            scope.fsPath,
            this.log,
            token,
            true,
            env,
        );
        throwIfCancelled(token);
        const data: unknown = JSON.parse(output);
        if (
            !Array.isArray(data) ||
            data.some(
                (item) =>
                    !item ||
                    typeof item.name !== 'string' ||
                    !item.name ||
                    typeof item.version !== 'string' ||
                    !item.version,
            )
        ) {
            throw new PythonToolError(
                'PACKAGE_QUERY_FAILED',
                l10n.t('Poetry returned invalid installed-package information.'),
                environment,
            );
        }
        return data.map(({ name, version }: { name: string; version: string }) =>
            this.api.createPackageItem({ name, displayName: name, version, description: version }, environment, this),
        );
    }

    async manage(
        environment: PythonEnvironment,
        options: PackageManagementOptions,
        toolToken?: CancellationToken,
        scope?: Uri,
    ): Promise<void> {
        throwIfCancelled(toolToken);
        if (toolToken && !scope) {
            throw new PythonToolError('INVALID_REQUEST', l10n.t('A project scope is required for Poetry tools.'));
        }
        const cwd = toolToken && scope ? scope.fsPath : await this.getProjectCwd();
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            if (options.runHeadless) {
                // Headless mode: skip the interactive package input prompt.
                if (toolToken) {
                    await this.enqueueEnvironmentOperation(environment, toolToken, async () => {
                        await this.verifyEnvironment(environment, cwd, toolToken, true);
                    });
                }
                return;
            }
            // Show package input UI if no packages are specified
            const installInput = await showInputBox({
                prompt: l10n.t('Enter packages to install (comma separated)'),
                placeHolder: l10n.t('e.g., requests, pytest, black'),
            });

            if (installInput) {
                toInstall = installInput
                    .split(',')
                    .map((p) => p.trim())
                    .filter((p) => p.length > 0);
            }

            if (toInstall.length === 0) {
                return;
            }
        }

        const execute = (token?: CancellationToken): Promise<void> =>
            this.enqueueEnvironmentOperation(environment, token, async () => {
            try {
                const toolExecution = toolToken !== undefined;
                const verified = await this.verifyEnvironment(environment, cwd, token, toolExecution);
                const cache = toolExecution ? this.sharedState.installedPackages : this.packages;
                const cacheKey = toolExecution ? verified.cacheKey : environment.envId.id;
                const before = cache.get(cacheKey);
                this.deletePackageCaches(environment, verified.cacheKey);
                await this.runPoetryManage(
                    { install: toInstall, uninstall: toUninstall },
                    cwd,
                    verified.env,
                    token,
                    toolExecution,
                );
                await this.updatePackagesForVerifiedEnvironment(
                    environment,
                    cwd,
                    verified.env,
                    {
                        before,
                        cacheKey,
                        token,
                        toolExecution,
                        fetchPackages:
                            toolToken && scope
                                ? () => this.fetchInstalledPackagesForTools(environment, toolToken, scope, verified.env)
                                : undefined,
                        skipDirectDependencies: toolExecution,
                    },
                );
            } catch (e) {
                if (e instanceof CancellationError) {
                    throw e;
                }
                this.log.error('Error managing packages with Poetry', e);
                if (!options.runHeadless) {
                    this.notifyPackageError(e, l10n.t('Error managing packages with Poetry'));
                }
                throw e;
            }
            });

        if (options.runHeadless) {
            await execute(toolToken);
            return;
        }

        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: l10n.t('Managing packages with Poetry'),
                cancellable: true,
            },
            (_progress, token) => execute(token),
        );
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        if (!this.project) {
            throw new PackageManagerRequiresProjectError();
        }
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: l10n.t('Refreshing Poetry packages'),
            },
            (_progress, token) => this.enqueueEnvironmentOperation(environment, token, async () => {
                try {
                    const cwd = await this.getProjectCwd();
                    const verified = await this.verifyEnvironment(environment, cwd, token);
                    await this.updatePackagesForVerifiedEnvironment(environment, cwd, verified.env, {
                        cacheKey: environment.envId.id,
                        token,
                    });
                } catch (error) {
                    if (error instanceof CancellationError) {
                        throw error;
                    }
                    this.log.error(`Failed to refresh packages: ${error}`);
                    if (isPoetryEnvironmentMismatch(error)) {
                        throw error;
                    }
                    this.notifyPackageError(error, l10n.t('Error refreshing Poetry packages'));
                }
            }),
        );
    }

    getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (!this.project) {
            return Promise.resolve(undefined);
        }
        return this.enqueueEnvironmentOperation(environment, undefined, async () => {
            const cwd = await this.getProjectCwd();
            const verified = await this.verifyEnvironment(environment, cwd);
            if (options?.skipCache || !this.packages.has(environment.envId.id)) {
                const packages = await this.fetchPackagesFromTool(environment, cwd, verified.env);
                this.packages.set(environment.envId.id, packages);
                return packages;
            }
            return this.packages.get(environment.envId.id);
        });
    }

    async getVersion(_environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        const poetry = await getPoetry();
        if (!poetry) {
            return undefined;
        }
        const versionCmd = new PoetryVersionCommand({
            pythonExecutable: poetry,
            log: this.log,
        });
        return await versionCmd.execute();
    }

    async getPackageAvailableVersions(_environment: PythonEnvironment, _packageName: string): Promise<Pep440Version[]> {
        throw new PackageVersionLookupNotSupportedError(
            'Poetry does not provide a package version lookup command supported by this extension.',
        );
    }

    formatInstallSpec(packageName: string, version: string): string {
        // Poetry uses `package@version` syntax for version-pinned installs
        return `${packageName}@${version}`;
    }

    dispose(): void {
        this.packagesChangedEmitter.dispose();
        this.packages.clear();
        if (this.ownsSharedState) {
            this.sharedState.installedPackages.clear();
            this.sharedState.environmentOperations.clear();
        }
    }

    private async runPoetryManage(
        options: { install?: string[]; uninstall?: string[] },
        cwd: string,
        env: NodeJS.ProcessEnv,
        token?: CancellationToken,
        toolExecution = false,
    ): Promise<void> {
        throwIfCancelled(token);
        const poetry = await getPoetry();
        if (!poetry) {
            throw new Error(
                l10n.t(
                    'Poetry executable not found. Install Poetry to manage packages, or set the "python.poetryPath" setting.',
                ),
            );
        }
        // Handle uninstalls first
        if (options.uninstall && options.uninstall.length > 0) {
            throwIfCancelled(token);
            const removeCmd = new PoetryRemoveCommand({
                pythonExecutable: poetry,
                cwd,
                log: this.log,
            });
            const packages = parsePackageSpecs(options.uninstall);
            await removeCmd.execute({ packages, cancellationToken: token, toolExecution, env });
        }

        // Handle installs
        if (options.install && options.install.length > 0) {
            throwIfCancelled(token);
            const addCmd = new PoetryAddCommand({
                pythonExecutable: poetry,
                cwd,
                log: this.log,
            });
            const packages = parsePackageSpecs(options.install);
            await addCmd.execute({ packages, cancellationToken: token, toolExecution, env });
            if (toolExecution) {
                // poetry add skips already-declared dependencies, even when they are not installed.
                await runPoetry(['install', '--no-root'], cwd, this.log, token, true, env);
            }
        }
    }

    private updatePackagesForVerifiedEnvironment(
        environment: PythonEnvironment,
        cwd: string,
        env: NodeJS.ProcessEnv,
        options: {
            before?: Package[];
            cacheKey?: string;
            token?: CancellationToken;
            toolExecution?: boolean;
            fetchPackages?: () => Promise<Package[] | undefined>;
            skipDirectDependencies?: boolean;
        } = {},
    ): Promise<Package[] | undefined> {
        const cache = options.skipDirectDependencies ? this.sharedState.installedPackages : this.packages;
        const cacheKey = options.cacheKey ?? environment.envId.id;
        return updatePackagesAndNotify(
            this,
            environment,
            options.before ?? cache.get(cacheKey),
            (changes) => {
                this.packagesChangedEmitter.fire({ environment, manager: this, changes });
            },
            options.fetchPackages ??
                (() =>
                    this.fetchPackagesFromTool(
                        environment,
                        cwd,
                        env,
                        options.token,
                        options.toolExecution,
                    )),
            options.skipDirectDependencies,
            options.skipDirectDependencies
                ? undefined
                : () =>
                      this.fetchDirectPackageNames(
                          cwd,
                          env,
                          options.token,
                          options.toolExecution,
                      ),
            (packages) => cache.set(cacheKey, packages),
        );
    }

    private async fetchPackagesFromTool(
        environment: PythonEnvironment,
        cwd: string,
        env: NodeJS.ProcessEnv,
        token?: CancellationToken,
        toolExecution = false,
    ): Promise<Package[]> {
        const poetry = await getPoetry();
        if (!poetry) {
            throw new Error(
                l10n.t(
                    'Poetry executable not found. Install Poetry to manage packages, or set the "python.poetryPath" setting.',
                ),
            );
        }

        const showCmd = new PoetryShowCommand({
            pythonExecutable: poetry,
            cwd,
            log: this.log,
        });
        try {
            const data = await showCmd.execute({ cancellationToken: token, toolExecution, env });
            return data.map((pkg) => this.api.createPackageItem(pkg, environment, this));
        } catch (error) {
            if (error instanceof CancellationError) {
                throw error;
            }
            this.log.error(`Error refreshing packages with Poetry: ${error}`);
            return [];
        }
    }

    getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        if (!this.project) {
            return Promise.resolve(undefined);
        }
        return this.enqueueEnvironmentOperation(environment, undefined, async () => {
            const cwd = await this.getProjectCwd();
            const verified = await this.verifyEnvironment(environment, cwd);
            return this.fetchDirectPackageNames(cwd, verified.env);
        });
    }

    private async fetchDirectPackageNames(
        cwd: string,
        env: NodeJS.ProcessEnv,
        token?: CancellationToken,
        toolExecution = false,
    ): Promise<Set<string> | undefined> {
        try {
            const poetry = await getPoetry();
            if (!poetry) {
                return undefined;
            }
            const showTopLevelCmd = new PoetryShowTopLevelCommand({
                pythonExecutable: poetry,
                cwd,
                log: this.log,
            });
            return await showTopLevelCmd.execute({ cancellationToken: token, toolExecution, env });
        } catch (err) {
            if (err instanceof CancellationError) {
                throw err;
            }
            this.log.error(`Error fetching direct package names with Poetry: ${err}`);
            return undefined;
        }
    }

    private notifyPackageError(error: unknown, fallbackMessage: string): void {
        const mismatch = isPoetryEnvironmentMismatch(error);
        let notificationKey: string | undefined;
        if (mismatch) {
            const projectKey = this.project?.uri.toString() ?? 'global';
            notificationKey = `${projectKey}\0${error.message}`;
            if (pendingPoetryEnvironmentMismatchNotifications.has(notificationKey)) {
                return;
            }
            pendingPoetryEnvironmentMismatchNotifications.add(notificationKey);
        }
        setImmediate(async () => {
            try {
                const viewOutput = l10n.t('View Output');
                const result = await showErrorMessage(mismatch ? error.message : fallbackMessage, viewOutput);
                if (result === viewOutput) {
                    this.log.show();
                }
            } finally {
                if (notificationKey) {
                    pendingPoetryEnvironmentMismatchNotifications.delete(notificationKey);
                }
            }
        });
    }

    private async getProjectCwd(): Promise<string> {
        if (!this.project) {
            throw new PackageManagerRequiresProjectError();
        }

        try {
            const stat = await workspaceFs.stat(this.project.uri);
            return (stat.type & FileType.Directory) === FileType.Directory
                ? this.project.uri.fsPath
                : path.dirname(this.project.uri.fsPath);
        } catch (error) {
            const message = l10n.t('Unable to access the Python project at "{0}".', this.project.uri.fsPath);
            this.log.error(message, error);
            throw new Error(message);
        }
    }
}
