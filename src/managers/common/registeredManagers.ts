// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { Pep440Version } from '@renovatebot/pep440';
import { CancellationError, Disposable, Event, LogOutputChannel, MarkdownString, RelativePattern } from 'vscode';
import { PackageVersionLookupNotSupportedError } from '../../publicErrors';
import { ISSUES_URL } from '../../common/constants';
import { CreateEnvironmentNotSupported, RemoveEnvironmentNotSupported } from '../../common/errors/NotSupportedError';
import { traceWarn } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError, isTimeoutErrorType } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import type {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    DidChangePackagesEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    GetPackageAvailableVersionsOptions,
    GetPackagesOptions,
    IconPath,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonProject,
    QuickCreateConfig,
    RefreshEnvironmentsScope,
    RemoveEnvironmentOptions,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../types';

/*
 * Runtime wrappers around registered {@link EnvironmentManager} and {@link PackageManager}
 * implementations. These decorate the extension-supplied managers with telemetry, "not
 * supported" fallbacks, and a stable internal `id`, without changing the public contracts
 * defined in `../../types`.
 */

export class InternalEnvironmentManager implements EnvironmentManager {
    public constructor(
        public readonly id: string,
        private readonly manager: EnvironmentManager,
    ) {}

    public get name(): string {
        return this.manager.name;
    }
    public get displayName(): string {
        return this.manager.displayName ?? this.name;
    }
    public get preferredPackageManagerId(): string {
        return this.manager.preferredPackageManagerId;
    }
    public get description(): string | undefined {
        return this.manager.description;
    }
    public get tooltip(): string | MarkdownString | undefined {
        return this.manager.tooltip;
    }
    public get iconPath(): IconPath | undefined {
        return this.manager.iconPath;
    }
    public get log(): LogOutputChannel | undefined {
        return this.manager.log;
    }

    public get supportsCreate(): boolean {
        return this.manager.create !== undefined;
    }

    create(
        scope: CreateEnvironmentScope,
        options: CreateEnvironmentOptions | undefined,
    ): Promise<PythonEnvironment | undefined> {
        if (this.manager.create) {
            return this.manager.create(scope, options);
        }

        return Promise.reject(new CreateEnvironmentNotSupported(`Create Environment not supported by: ${this.id}`));
    }

    public get supportsQuickCreate(): boolean {
        return this.manager.quickCreateConfig !== undefined && this.manager.create !== undefined;
    }

    quickCreateConfig(): QuickCreateConfig | undefined {
        if (this.manager.quickCreateConfig && this.manager.create) {
            return this.manager.quickCreateConfig();
        }
        throw new CreateEnvironmentNotSupported(`Quick Create Environment not supported by: ${this.id}`);
    }

    public get supportsRemove(): boolean {
        return this.manager.remove !== undefined;
    }

    remove(scope: PythonEnvironment, options?: RemoveEnvironmentOptions): Promise<void> {
        return this.manager.remove
            ? this.manager.remove(scope, options)
            : Promise.reject(new RemoveEnvironmentNotSupported(`Remove Environment not supported by: ${this.id}`));
    }

    async refresh(options: RefreshEnvironmentsScope): Promise<void> {
        const sw = new StopWatch();
        const SLOW_DISCOVERY_THRESHOLD_MS = 15000;
        try {
            await this.manager.refresh(options);
            const envs = await this.manager.getEnvironments('all').catch(() => []);
            const duration = sw.elapsedTime;
            sendTelemetryEvent(EventNames.ENVIRONMENT_DISCOVERY, duration, {
                managerId: this.id,
                result: 'success',
                envCount: envs.length,
            });

            // Log warning for slow discovery
            if (duration > SLOW_DISCOVERY_THRESHOLD_MS) {
                traceWarn(
                    `[${this.displayName}] Environment discovery took ${(duration / 1000).toFixed(1)}s (found ${envs.length} environments). ` +
                        `If this is causing problems, please report it: ${ISSUES_URL}/new`,
                );
            }
        } catch (ex) {
            const duration = sw.elapsedTime;
            const errorType = classifyError(ex);
            sendTelemetryEvent(
                EventNames.ENVIRONMENT_DISCOVERY,
                duration,
                {
                    managerId: this.id,
                    result: errorType === 'canceled' || isTimeoutErrorType(errorType) ? 'timeout' : 'error',
                    errorType,
                },
                ex instanceof Error ? ex : undefined,
            );

            // Log verbose failure message to help users report issues
            const errorMessage = ex instanceof Error ? ex.message : String(ex);
            traceWarn(
                `[${this.displayName}] Environment discovery failed after ${(duration / 1000).toFixed(1)}s.\n` +
                    `  Error: ${errorType} - ${errorMessage}\n` +
                    `  If environments are not being detected correctly, please report this issue:\n` +
                    `  ${ISSUES_URL}/new`,
            );

            throw ex;
        }
    }

    getEnvironments(options: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        return this.manager.getEnvironments(options);
    }

    onDidChangeEnvironments(handler: (e: DidChangeEnvironmentsEventArgs) => void): Disposable {
        return this.manager.onDidChangeEnvironments
            ? this.manager.onDidChangeEnvironments(handler)
            : new Disposable(() => {});
    }

    set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        return this.manager.set(scope, environment);
    }
    get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return this.manager.get(scope);
    }

    onDidChangeEnvironment(handler: (e: DidChangeEnvironmentEventArgs) => void): Disposable {
        return this.manager.onDidChangeEnvironment
            ? this.manager.onDidChangeEnvironment(handler)
            : new Disposable(() => {});
    }

    resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return this.manager.resolve(context);
    }

    public equals(other: EnvironmentManager): boolean {
        return this.manager === other;
    }

    public supportsClearCache(): boolean {
        return this.manager.clearCache !== undefined;
    }

    public clearCache(): Promise<void> {
        return this.manager.clearCache ? this.manager.clearCache() : Promise.resolve();
    }
}

function inferPackageManagementTrigger(
    options: PackageManagementOptions,
): 'ui' | 'requirements' | 'package' | 'uninstall' {
    const hasInstall = options.install && options.install.length > 0;
    const hasUninstall = options.uninstall && options.uninstall.length > 0;
    if (!hasInstall && hasUninstall) {
        return 'uninstall';
    }
    if (!hasInstall) {
        return 'ui'; // empty install list opens the package picker UI
    }
    if (options.install?.some((arg) => arg === '-r' || arg === '--requirement')) {
        return 'requirements';
    }
    return 'package';
}

export class InternalPackageManager implements PackageManager {
    private readonly relatedManagers: WeakSet<PackageManager>;

    public constructor(
        public readonly id: string,
        private readonly manager: PackageManager,
        public readonly project?: PythonProject,
        relatedManagers?: WeakSet<PackageManager>,
    ) {
        this.relatedManagers = relatedManagers ?? new WeakSet<PackageManager>();
        this.relatedManagers.add(manager);
    }

    public get name(): string {
        return this.manager.name;
    }
    public get displayName(): string {
        return this.manager.displayName ?? this.name;
    }
    public get description(): string | undefined {
        return this.manager.description;
    }
    public get tooltip(): string | MarkdownString | undefined {
        return this.manager.tooltip;
    }
    public get iconPath(): IconPath | undefined {
        return this.manager.iconPath;
    }
    public get log(): LogOutputChannel | undefined {
        return this.manager.log;
    }

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        const stopWatch = new StopWatch();
        const triggerSource = inferPackageManagementTrigger(options);
        try {
            await this.manager.manage(environment, options);
            sendTelemetryEvent(EventNames.PACKAGE_MANAGEMENT, stopWatch.elapsedTime, {
                managerId: this.id,
                result: 'success',
                triggerSource,
            });
        } catch (error) {
            if (error instanceof CancellationError) {
                sendTelemetryEvent(EventNames.PACKAGE_MANAGEMENT, stopWatch.elapsedTime, {
                    managerId: this.id,
                    result: 'cancelled',
                    triggerSource,
                });
                throw error;
            }
            sendTelemetryEvent(EventNames.PACKAGE_MANAGEMENT, stopWatch.elapsedTime, {
                managerId: this.id,
                result: 'error',
                errorType: error instanceof Error ? error.name : 'unknown',
                triggerSource,
            });
            throw error;
        }
    }

    refresh(environment: PythonEnvironment): Promise<void> {
        return this.manager.refresh(environment);
    }

    getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        return this.manager.getPackages(environment, options);
    }

    getPackageWatchTargets(environment: PythonEnvironment): RelativePattern[] {
        return this.manager.getPackageWatchTargets?.(environment) ?? [];
    }

    onDidChangePackages(handler: (e: DidChangePackagesEventArgs) => void): Disposable {
        return this.manager.onDidChangePackages ? this.manager.onDidChangePackages(handler) : new Disposable(() => {});
    }

    get packageChangeEvent(): Event<DidChangePackagesEventArgs> | undefined {
        return this.manager.onDidChangePackages;
    }

    get supportsProjectBinding(): boolean {
        return this.manager.createForProject !== undefined;
    }

    wraps(other: PackageManager): boolean {
        return this.manager === other;
    }

    equals(other: PackageManager): boolean {
        return this.relatedManagers.has(other);
    }

    createProjectScopedManager(project: PythonProject): InternalPackageManager | undefined {
        const manager = this.manager.createForProject?.(project);
        return manager ? new InternalPackageManager(this.id, manager, project, this.relatedManagers) : undefined;
    }

    getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        return this.manager.getVersion ? this.manager.getVersion(environment) : Promise.resolve(undefined);
    }

    getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
        options: GetPackageAvailableVersionsOptions & { errorMode: 'throw' },
    ): Promise<Pep440Version[]>;
    getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
        options?: GetPackageAvailableVersionsOptions,
    ): Promise<Pep440Version[] | undefined>;

    /**
     * Delegates version lookup to the underlying package manager using the requested error mode.
     */
    async getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
        options?: GetPackageAvailableVersionsOptions,
    ): Promise<Pep440Version[] | undefined> {
        const shouldThrow = options?.errorMode === 'throw';
        try {
            if (!this.manager.getPackageAvailableVersions) {
                throw new PackageVersionLookupNotSupportedError(
                    `Package version lookup is not supported by package manager: ${this.id}`,
                );
            }
            const versions = await this.manager.getPackageAvailableVersions(environment, packageName);
            if (versions === undefined && shouldThrow) {
                throw new PackageVersionLookupNotSupportedError(
                    `Package version lookup is not supported by package manager: ${this.id}`,
                );
            }
            return versions;
        } catch (error) {
            if (shouldThrow) {
                throw error;
            }
            return undefined;
        }
    }

    getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        return this.manager.getDirectPackageNames
            ? this.manager.getDirectPackageNames(environment)
            : Promise.resolve(undefined);
    }

    formatInstallSpec(packageName: string, version: string): string {
        return this.manager.formatInstallSpec
            ? this.manager.formatInstallSpec(packageName, version)
            : `${packageName}==${version}`;
    }
}
