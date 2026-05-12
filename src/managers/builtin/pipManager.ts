import { compare, explain as parse, rcompare } from '@renovatebot/pep440';
import type { Pep440Version } from '@renovatebot/pep440';
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
    IconPath,
    Package,
    PackageChangeKind,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { runProcessCaptureAll, runPython, runUV, shouldUseUv } from './helpers';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { managePackages, refreshPackages } from './utils';
import { VenvManager } from './venvManager';

function getChanges(before: Package[], after: Package[]): { kind: PackageChangeKind; pkg: Package }[] {
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];
    before.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.remove, pkg });
    });
    after.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.add, pkg });
    });
    return changes;
}

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
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await managePackages(environment, manageOptions, this.api, this, token);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
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
                const before = this.packages.get(environment.envId.id) ?? [];
                const after = await refreshPackages(environment, this.api, this);
                const changes = getChanges(before, after);
                this.packages.set(environment.envId.id, after);
                if (changes.length > 0) {
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
                }
            },
        );
    }
    async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
        if (!this.packages.has(environment.envId.id)) {
            await this.refresh(environment);
        }
        return this.packages.get(environment.envId.id);
    }

    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            if (useUv) {
                const result = await runUV(['--version'], undefined, this.log);
                // "uv X.Y.Z"
                const match = result.match(/^uv\s+(\d+\.\d+(?:\.\d+)*)/);
                return match ? parse(match[1]) ?? undefined : undefined;
            }
            const result = await runPython(
                environment.execInfo?.run?.executable ?? 'python',
                ['-m', 'pip', '--version'],
                undefined,
                this.log,
            );
            // "pip X.Y.Z from /path/to/pip (python X.Y)"
            const match = result.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
            return match ? parse(match[1]) ?? undefined : undefined;
        } catch {
            return undefined;
        }
    }

    async getAvailableVersions(packageName: string, environment: PythonEnvironment): Promise<Pep440Version[] | undefined> {
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
            if (pipVersion && compare(pipVersion.public, '21.2.0') >= 0) {
                const output = await runPython(
                    python,
                    ['-m', 'pip', 'index', 'versions', packageName, '--json'],
                    undefined,
                    this.log,
                );
                return parsePipIndexVersionsJson(output);
            }

            // pip <= 20.3.4 - use `pip install <package>==__invalid__` to get available versions from error message.
            if (pipVersion && compare(pipVersion.public, '20.3.4') <= 0) {
                const result = await runProcessCaptureAll(
                    python,
                    ['-m', 'pip', 'install', `${packageName}==__invalid__`],
                    this.log,
                );
                return parsePipInstallVersions(result.stdout + result.stderr);
            }
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
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
export function parsePipInstallVersions(output: string): Pep440Version[] | undefined {
    const match = output.match(/from versions:\s*([^\)]+)\)/);
    if (match && match[1]) {
        const versions = match[1]
            .split(',')
            .filter((v) => !!v.trim())
            .map((v) => parse(v.trim()))
            .filter((v): v is Pep440Version => v !== null)
            .sort((a, b) => rcompare(a.public, b.public));
        return versions.length > 0 ? versions : undefined;
    }
}

/**
 * Parses JSON output from `pip index versions <package> --json`.
 * Expected format: { "name": "...", "versions": ["1.2.3", "1.2.2", ...] }
 */
export function parsePipIndexVersionsJson(output: string): Pep440Version[] | undefined {
    // Only capture output between braces
    const match = output.match(/{[\s\S]*}/);
    if (!match) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(match[0]);
        if (parsed && Array.isArray(parsed.versions) && parsed.versions.length > 0) {
            return (parsed.versions as string[])
                .filter((v) => !!v.trim())
                .map((v) => parse(v))
                .filter((v): v is Pep440Version => v !== null)
                .sort((a, b) => rcompare(a.public, b.public));
        }
        return undefined;
    } catch {
        return undefined;
    }
}
