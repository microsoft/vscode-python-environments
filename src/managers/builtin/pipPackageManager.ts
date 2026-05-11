import * as semver from 'semver';
import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
    window,
} from 'vscode';
import {
    DidChangePackagesEventArgs,
    GetPackagesOptions,
    IconPath,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { runPython, runUV, shouldUseUv } from './helpers';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { managePackages, refreshPipDirectPackageNames, refreshPipPackages } from './utils';
import { VenvManager } from './venvManager';

export class PipPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        private readonly venv: VenvManager,
    ) {
        this.name = 'pip';
        this.displayName = 'Pip';
        this.description = 'This package manager for python installs using pip.';
        this.tooltip = new MarkdownString('This package manager for python installs using `pip`.');
        this.iconPath = new ThemeIcon('python');
    }
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
    readonly iconPath?: IconPath;

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            const projects = this.venv.getProjectsByEnvironment(environment);
            const result = await getWorkspacePackagesToInstall(this.api, options, projects, environment, this.log);
            if (result) {
                toInstall = result.install;
                toUninstall = result.uninstall;
            } else {
                return;
            }
        }

        const manageOptions = {
            ...options,
            install: toInstall,
            uninstall: toUninstall,
        };
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    await managePackages(environment, manageOptions, this, token);
                    await updatePackagesAndNotify(
                        this,
                        environment,
                        this.packages.get(environment.envId.id),
                        (changes) => {
                            this._onDidChangePackages.fire({ environment, manager: this, changes });
                        },
                    );
                } catch (e) {
                    if (e instanceof CancellationError) {
                        throw e;
                    }
                    this.log.error('Error managing packages', e);
                    setImmediate(async () => {
                        const result = await window.showErrorMessage('Error managing packages', 'View Output');
                        if (result === 'View Output') {
                            this.log.show();
                        }
                    });
                    throw e;
                }
            },
        );
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing packages',
            },
            async () => {
                await updatePackagesAndNotify(this, environment, this.packages.get(environment.envId.id), (changes) => {
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
                });
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            const data = await refreshPipPackages(environment, this.log);
            const packages = (data ?? []).map((pkg) => this.api.createPackageItem(pkg, environment, this));
            this.packages.set(environment.envId.id, packages);
            return packages;
        }
        return this.packages.get(environment.envId.id);
    }

    async getVersion(environment: PythonEnvironment): Promise<semver.SemVer | undefined> {
        try {
            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            if (useUv) {
                const result = await runUV(['--version'], undefined, this.log);
                // "uv X.Y.Z"
                const match = result.match(/^uv\s+(\d+\.\d+(?:\.\d+)*)/);
                return match ? (semver.coerce(match[1]) ?? undefined) : undefined;
            }
            const result = await runPython(
                environment.execInfo?.run?.executable ?? 'python',
                ['-m', 'pip', '--version'],
                undefined,
                this.log,
            );
            // "pip X.Y.Z from /path/to/pip (python X.Y)"
            const match = result.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
            return match ? (semver.coerce(match[1]) ?? undefined) : undefined;
        } catch {
            return undefined;
        }
    }

    async getAvailableVersions(packageName: string, environment: PythonEnvironment): Promise<string[] | undefined> {
        try {
            const python = environment.execInfo?.run?.executable;
            if (!python) {
                return undefined;
            }

            // uv - Run pip through pipx
            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            if (useUv) {
                const output = await runUV(
                    ['tool', 'run', 'pip', 'index', 'versions', packageName, '--json'],
                    undefined,
                    this.log,
                );
                return parsePipIndexVersionsJson(output);
            }

            // pip >= 21.2.0 - use `pip index versions <package> --json` to get available versions in a machine readable format.
            const pipVersion = await this.getVersion(environment);
            if (pipVersion && semver.gte(pipVersion, '21.2.0')) {
                const output = await runPython(
                    python,
                    ['-m', 'pip', 'index', 'versions', packageName, '--json'],
                    undefined,
                    this.log,
                );
                return parsePipIndexVersionsJson(output);
            }

            // pip <= 20.3.4 - use `pip install <package>==__invalid__` to get available versions from error message.
            if (pipVersion && semver.lte(pipVersion, '20.3.4')) {
                const output = await runPython(
                    python,
                    ['-m', 'pip', 'install', `${packageName}==__invalid__`],
                    undefined,
                    this.log,
                );
                return parsePipInstallVersions(output);
            }
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }

    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        const data = await refreshPipDirectPackageNames(environment, this.log);
        return data ? new Set(data) : undefined;
    }
}

/**
 * Parses the output of `pip install <package>==__invalid__` to extract available versions.
 * Expected output format:
 * ```
 * Collecting <package>==__invalid__
 *   Could not find a version that satisfies the requirement <package>==__invalid__ (from versions: 1.2.3, 1.2.2, ...)
 *   No matching distribution found for <package>==__invalid__
 * ```
 */
export function parsePipInstallVersions(output: string): string[] | undefined {
    const match = output.match(/from versions:\s*([^\)]+)\)/);
    if (match && match[1]) {
        return match[1]
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
    }
}

/**
 * Parses JSON output from `pip index versions <package> --json`.
 * Expected format: { "name": "...", "versions": ["1.2.3", "1.2.2", ...] }
 */
export function parsePipIndexVersionsJson(output: string): string[] | undefined {
    // Only capture output between braces
    const match = output.match(/{[\s\S]*}/);
    if (!match) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(match[0]);
        if (parsed && Array.isArray(parsed.versions) && parsed.versions.length > 0) {
            return parsed.versions;
        }
        return undefined;
    } catch {
        return undefined;
    }
}
