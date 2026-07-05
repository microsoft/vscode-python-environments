import type { Pep440Version } from '@renovatebot/pep440';
import { compare, explain as parse, rcompare } from '@renovatebot/pep440';
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
import { PipInstallCommand, PipUninstallCommand, UvInstallCommand, UvUninstallCommand } from './commands/index';
import { runPython, runUV, shouldUseUv } from './helpers';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { normalizePackageName, parsePackageSpecs, refreshPipDirectPackageNames, refreshPipPackages } from './utils';
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

        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Installing packages',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const pythonExecutable = environment.execInfo?.run?.executable;
                    if (!pythonExecutable) {
                        throw new Error('Unable to determine Python executable path');
                    }

                    // Detect whether to use UV
                    const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);

                    // Execute uninstall if needed
                    if (toUninstall.length > 0) {
                        const UninstallCommand = useUv ? UvUninstallCommand : PipUninstallCommand;
                        const uninstallCmd = new UninstallCommand({
                            pythonExecutable,
                            log: this.log,
                            cancellationToken: token,
                        });
                        const packages = parsePackageSpecs(toUninstall);
                        await uninstallCmd.execute(packages);
                    }

                    // Execute install if needed
                    if (toInstall.length > 0) {
                        const InstallCommand = useUv ? UvInstallCommand : PipInstallCommand;
                        const installCmd = new InstallCommand({
                            pythonExecutable,
                            log: this.log,
                            cancellationToken: token,
                        });
                        const packages = parsePackageSpecs(toInstall);
                        await installCmd.execute(packages, options.upgrade);
                    }

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

    async refresh(environment: PythonEnvironment): Promise<Package[] | undefined> {
        return window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing packages',
            },
            async () => {
                return updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    },
                );
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

    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        try {
            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            if (useUv) {
                const result = await runUV(['--version'], undefined, this.log);
                // "uv X.Y.Z"
                const match = result.match(/^uv\s+(\d+\.\d+(?:\.\d+)*)/);
                return match ? (parse(match[1]) ?? undefined) : undefined;
            }
            const result = await runPython(
                environment.execInfo?.run?.executable ?? 'python',
                ['-m', 'pip', '--version'],
                undefined,
                this.log,
            );
            // "pip X.Y.Z from /path/to/pip (python X.Y)"
            const match = result.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
            return match ? (parse(match[1]) ?? undefined) : undefined;
        } catch {
            return undefined;
        }
    }

    async getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[] | undefined> {
        try {
            const python = environment.execInfo?.run?.executable;
            if (!python) {
                return undefined;
            }

            const baseVersion = parse(environment.version)?.base_version;
            if (!baseVersion) {
                return undefined;
            }
            // uv - Run pip via `uv tool run pip`
            const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
            if (useUv) {
                const output = await runUV(
                    ['tool', 'run', 'pip', 'index', 'versions', packageName, '--json', '--python-version', baseVersion],
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
                    ['-m', 'pip', 'index', 'versions', packageName, '--json', '--python-version', baseVersion],
                    undefined,
                    this.log,
                );
                return parsePipIndexVersionsJson(output);
            }

            // pip <= 20.3.4 - version picking is undefined; no reliable machine-readable API exists.
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }

    /**
     * Returns direct (non-transitive) package names using `pip list --not-required` or `uv pip tree --depth=0`.
     *
     * Note: These commands return packages with no installed dependents (leaf packages), not packages
     * the user explicitly installed. pip/uv do not track install intent.
     */
    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        const data = await refreshPipDirectPackageNames(environment, this.log);
        return data ? new Set(data.map(normalizePackageName)) : undefined;
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
                .map((v) => parse(v.trim()))
                .filter((v): v is Pep440Version => v !== null)
                .sort((a, b) => rcompare(a.public, b.public));
        }
        return undefined;
    } catch {
        return undefined;
    }
}
