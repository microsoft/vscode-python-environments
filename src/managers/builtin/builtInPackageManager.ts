import type { Pep440Version } from '@renovatebot/pep440';
import { CancellationToken, Disposable, Uri } from 'vscode';
import {
    Capabilities,
    CapabilityCheck,
    GetPackagesOptions,
    Package,
    PackageCapability,
    PackageManagementOptions,
    PackageManager,
    PackageManagerCapability,
    PythonEnvironment,
} from '../../api';
import { PackageToolSupport, pythonToolSupport, throwIfCancelled } from '../../internal/pythonToolSupport';
import { shouldUseUv } from './helpers';
import { PipPackageManager } from './pipPackageManager';
import { UvPackageManager } from './uvPackageManager';

/** Routes the existing built-in pip entry point to independent pip and uv managers. */
export class BuiltInPackageManager implements PackageManager, Disposable {
    constructor(
        private readonly pip: PipPackageManager,
        private readonly uv: UvPackageManager,
    ) {
        this.pip.setPackageManagerOwner(this);
    }

    readonly name = 'pip';
    readonly displayName = 'Pip';

    get description() {
        return this.pip.description;
    }
    get tooltip() {
        return this.pip.tooltip;
    }
    get iconPath() {
        return this.pip.iconPath;
    }
    get onDidChangePackages() {
        return this.pip.onDidChangePackages;
    }

    readonly capabilities: Capabilities<PackageManagerCapability> = {
        [PackageCapability.List]: this.routeCapability(PackageCapability.List),
        [PackageCapability.Install]: this.routeCapability(PackageCapability.Install),
        [PackageCapability.Uninstall]: this.routeCapability(PackageCapability.Uninstall),
        [PackageCapability.Upgrade]: this.routeCapability(PackageCapability.Upgrade),
        [PackageCapability.FetchAvailableVersions]: this.routeCapability(PackageCapability.FetchAvailableVersions),
        [PackageCapability.ListDirect]: this.routeCapability(PackageCapability.ListDirect),
    };

    readonly [pythonToolSupport]: PackageToolSupport = {
        manage: (environment, options, token, scope) =>
            this.manage(environment, { ...options, runHeadless: true }, token, scope),
        getPackages: async (environment, token, scope) =>
            (await this.getManager(environment, token))[pythonToolSupport].getPackages(environment, token, scope),
    };

    private async getManager(
        environment: PythonEnvironment,
        token?: CancellationToken,
    ): Promise<PipPackageManager | UvPackageManager> {
        throwIfCancelled(token);
        if (!environment.execInfo?.run?.executable) {
            return this.pip;
        }
        const envPath = environment.environmentPath.fsPath;
        return await shouldUseUv(this.pip.log, envPath, envPath, token) ? this.uv : this.pip;
    }

    private routeCapability(capability: PackageManagerCapability): CapabilityCheck {
        return async (context) => {
            const manager = context.environment ? await this.getManager(context.environment) : this.pip;
            return manager.capabilities[capability](context);
        };
    }

    /** Routes package mutations using the existing automatic uv rules. */
    async manage(
        environment: PythonEnvironment,
        options: PackageManagementOptions,
        toolToken?: CancellationToken,
        scope?: Uri,
    ): Promise<void> {
        throwIfCancelled(toolToken);
        if (!options.install?.length && !options.uninstall?.length && options.runHeadless) {
            return;
        }
        const support = await this.pip.capabilities[PackageCapability.Install]({ environment });
        const manager = support.supported ? await this.getManager(environment, toolToken) : this.pip;
        return manager.manage(environment, options, toolToken, scope);
    }

    /** Refreshes packages through the selected backend. */
    async refresh(environment: PythonEnvironment): Promise<void> {
        return (await this.getManager(environment)).refresh(environment);
    }

    /** Lists packages through the selected backend, preserving its cache behavior. */
    async getPackages(environment: PythonEnvironment, options?: GetPackagesOptions): Promise<Package[] | undefined> {
        return (await this.getManager(environment)).getPackages(environment, options);
    }

    /** Returns the version of the selected backend. */
    async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
        return (await this.getManager(environment)).getVersion(environment);
    }

    /** Looks up compatible package versions through the selected backend. */
    async getPackageAvailableVersions(environment: PythonEnvironment, packageName: string): Promise<Pep440Version[]> {
        return (await this.getManager(environment)).getPackageAvailableVersions(environment, packageName);
    }

    /** Lists dependency-root package names through the selected backend. */
    async getDirectPackageNames(environment: PythonEnvironment): Promise<Set<string> | undefined> {
        return (await this.getManager(environment)).getDirectPackageNames(environment);
    }

    /** Releases the pip fallback owned by this registered entry point. */
    dispose(): void {
        this.pip.dispose();
    }
}
