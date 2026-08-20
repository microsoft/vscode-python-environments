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
    PackageVersionLookupNotSupportedError,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { runPython, runUV, shouldUseUv } from './helpers';
import { getWorkspacePackagesToInstall } from './pipUtils';
import { managePackages, normalizePackageName, refreshPipDirectPackageNames, refreshPipPackages } from './utils';
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
            if (options.runHeadless) {
                // Headless mode: skip the interactive package picker.
                return;
            }
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
                        () => this.fetchPackages(environment, !manageOptions.runHeadless),
                    );
                } catch (e) {
                    if (e instanceof CancellationError) {
                        throw e;
                    }
                    this.log.error('Error managing packages', e);
                    if (!manageOptions.runHeadless) {
                        setImmediate(async () => {
                            const result = await window.showErrorMessage('Error managing packages', 'View Output');
                            if (result === 'View Output') {
                                this.log.show();
                            }
                        });
                    }
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
                const packages = await updatePackagesAndNotify(
                    this,
                    environment,
                    this.packages.get(environment.envId.id),
                    (changes) => {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    },
                );
                if (packages !== undefined) {
                    this.packages.set(environment.envId.id, packages);
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        if (options?.skipCache || !this.packages.has(environment.envId.id)) {
            return this.fetchPackages(environment);
        }
        return this.packages.get(environment.envId.id);
    }

    private async fetchPackages(environment: PythonEnvironment, showErrors = true): Promise<Package[] | undefined> {
        const data = await refreshPipPackages(environment, this.log, { showErrors });
        if (data === undefined) {
            return this.packages.get(environment.envId.id);
        }

        const packages = data.map((pkg) => this.api.createPackageItem(pkg, environment, this));
        this.packages.set(environment.envId.id, packages);
        return packages;
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

    /**
     * Lists available versions for a package, newest first.
     *
     * Distinguishes an unsupported capability from an operational failure:
     * - Throws {@link PackageVersionLookupNotSupportedError} when the environment's pip is older
     *   than 21.2 (which predates `pip index versions`).
     * - Lets operational failures (missing interpreter/version, command, network, or
     *   malformed/unparseable output) propagate instead of returning `undefined`.
     *
     * @param environment - The Python environment to query.
     * @param packageName - The package whose versions should be listed.
     * @returns A promise that resolves to an array of {@link Pep440Version} objects.
     * @throws {@link PackageVersionLookupNotSupportedError} when pip is too old to list versions.
     */
    async getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[]> {
        const python = environment.execInfo?.run?.executable;
        if (!python) {
            throw new Error(`Python executable is unavailable for environment: ${environment.envId.id}`);
        }

        const baseVersion = getPythonVersionForPackageLookup(environment.version);
        if (!baseVersion) {
            throw new Error(`Python version is unavailable for environment: ${environment.envId.id}`);
        }

        // uv - Run pip via `uv tool run pip`; uv always emits the machine-readable JSON output.
        const useUv = await shouldUseUv(this.log, environment.environmentPath.fsPath);
        if (useUv) {
            const output = await runUV(
                ['tool', 'run', 'pip', 'index', 'versions', packageName, '--json', '--python-version', baseVersion],
                undefined,
                this.log,
            );
            return requireParsedVersions(parsePipIndexVersionsJson(output), 'uv');
        }

        const pipVersion = await this.resolvePipVersionOrThrow(python);

        // pip >= 25.1 - `pip index versions <package> --json` returns a machine-readable format.
        if (compare(pipVersion.public, '25.1') >= 0) {
            const output = await runPython(
                python,
                ['-m', 'pip', 'index', 'versions', packageName, '--json', '--python-version', baseVersion],
                undefined,
                this.log,
            );
            return requireParsedVersions(parsePipIndexVersionsJson(output), 'pip');
        }

        // pip 21.2 - 25.0 - only the human-readable text output is available.
        if (compare(pipVersion.public, '21.2') >= 0) {
            const output = await runPython(
                python,
                ['-m', 'pip', 'index', 'versions', packageName, '--python-version', baseVersion],
                undefined,
                this.log,
            );
            return requireParsedVersions(parsePipIndexVersionsText(output), 'pip');
        }

        // pip < 21.2 predates `pip index versions`; version lookup is an unsupported capability.
        throw new PackageVersionLookupNotSupportedError(
            `Package version lookup requires pip 21.2 or newer; the environment has pip ${pipVersion.public}.`,
        );
    }

    /**
     * Resolves the environment's pip version, throwing when it cannot be determined.
     *
     * Unlike {@link getVersion}, failures here propagate so an operational problem (for example,
     * pip is missing or the command fails) is surfaced instead of being misreported as an
     * unsupported capability.
     */
    private async resolvePipVersionOrThrow(python: string): Promise<Pep440Version> {
        const result = await runPython(python, ['-m', 'pip', '--version'], undefined, this.log);
        // "pip X.Y.Z from /path/to/pip (python X.Y)"
        const match = result.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
        const version = match ? parse(match[1]) : null;
        if (!version) {
            throw new Error(`Unable to determine the pip version from: ${result.trim()}`);
        }
        return version;
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
 * Ensures a parse step produced versions, converting a parsing miss into a propagating
 * operational error instead of silently returning `undefined`.
 */
function requireParsedVersions(versions: Pep440Version[] | undefined, tool: 'pip' | 'uv'): Pep440Version[] {
    if (!versions) {
        throw new Error(`Unable to parse available package versions from ${tool} output.`);
    }
    return versions;
}

/**
 * Extracts a `major.minor[.micro]` string suitable for pip's `--python-version` flag from a
 * Python interpreter version string.
 *
 * Interpreter versions can include release-level and serial suffixes (for example
 * `3.13.14.final.0`) that are not valid PEP 440 versions, so this uses a tolerant numeric-prefix
 * match instead of a PEP 440 parse.
 *
 * @param version - The interpreter version string (e.g. `"3.13.14"` or `"3.13.14.final.0"`).
 * @returns The dotted numeric version (e.g. `"3.13.14"`), or `undefined` when there is no numeric prefix.
 */
export function getPythonVersionForPackageLookup(version: string): string | undefined {
    const match = version.match(/^\s*(\d+)\.(\d+)(?:\.(\d+))?/);
    return match ? [match[1], match[2], match[3]].filter((segment) => segment !== undefined).join('.') : undefined;
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

/** Parses the legacy text output from `pip index versions <package>`. */
export function parsePipIndexVersionsText(output: string): Pep440Version[] | undefined {
    const match = output.match(/^Available versions:\s*(.+)$/im);
    if (!match) {
        return undefined;
    }
    const versions = match[1]
        .split(',')
        .map((version) => parse(version.trim()))
        .filter((version): version is Pep440Version => version !== null)
        .sort((a, b) => rcompare(a.public, b.public));
    return versions.length > 0 ? versions : undefined;
}
