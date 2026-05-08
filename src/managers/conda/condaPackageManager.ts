import * as semver from 'semver';
import {
    CancellationError,
    Disposable,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
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
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { CondaStrings } from '../../common/localize';
import { traceError } from '../../common/logging';
import { withProgress } from '../../common/window.apis';
import { updatePackagesAndNotify } from '../common/packageChanges';
import { getCommonCondaPackagesToInstall, managePackages, runCondaExecutable } from './condaUtils';

export class CondaPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        public readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
    ) {
        this.name = 'conda';
        this.displayName = 'Conda';
        this.description = CondaStrings.condaPackageMgr;
        this.tooltip = CondaStrings.condaPackageMgr;
    }
    name: string;
    displayName?: string;
    description?: string;
    tooltip?: string | MarkdownString;
    iconPath?: IconPath;

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            const result = await getCommonCondaPackagesToInstall(environment, options, this.api);
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
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: CondaStrings.condaInstallingPackages,
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    await managePackages(environment, manageOptions, token, this.log);
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

                    this.log.error('Error installing packages', e);
                    setImmediate(async () => {
                        await showErrorMessageWithLogs(CondaStrings.condaInstallError, this.log);
                    });
                }
            },
        );
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: CondaStrings.condaRefreshingPackages,
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
            const args = ['list', '-p', environment.environmentPath.fsPath, '--json'];
            const data = await runCondaExecutable(args);

            let condaPackages: { name: string; version: string }[];
            try {
                condaPackages = JSON.parse(data) as { name: string; version: string }[];
            } catch (e) {
                traceError(`Failed to parse conda list JSON output: ${data}`, e);
                return [];
            }

            const packages: Package[] = [];
            for (const condaPkg of condaPackages) {
                if (condaPkg.name && condaPkg.version) {
                    packages.push(
                        this.api.createPackageItem(
                            {
                                name: condaPkg.name,
                                displayName: condaPkg.name,
                                version: condaPkg.version,
                                description: condaPkg.version,
                            },
                            environment,
                            this,
                        ),
                    );
                }
            }
            this.packages.set(environment.envId.id, packages);
            return packages;
        }
        return this.packages.get(environment.envId.id);
    }

    async getVersion(_environment: PythonEnvironment): Promise<semver.SemVer | undefined> {
        try {
            const output = await runCondaExecutable(['--version'], this.log);
            // "conda X.Y.Z"
            const match = output.match(/conda\s+(\d+\.\d+(?:\.\d+)*)/i);
            return match ? (semver.coerce(match[1]) ?? undefined) : undefined;
        } catch {
            return undefined;
        }
    }

    async getAvailableVersions(packageName: string, _environment: PythonEnvironment): Promise<string[] | undefined> {
        try {
            const output = await runCondaExecutable(['search', packageName, '--json'], this.log);
            const parsed = JSON.parse(output);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed[packageName])) {
                const versions: string[] = parsed[packageName]
                    .map((entry: { version?: string }) => entry.version)
                    .filter((v: unknown): v is string => typeof v === 'string');
                // Deduplicate and return newest first
                return [...new Set(versions)].reverse();
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    dispose() {
        this._onDidChangePackages.dispose();
        this.packages.clear();
    }
}
