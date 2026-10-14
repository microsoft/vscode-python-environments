// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';
import { getLegacyEnvironmentManagerCapability, getLegacyPackageManagerCapability } from './legacyCapabilities.js';
import type {
    CreateEnvironmentScope,
    EnvironmentManager,
    GetEnvironmentsScope,
    PackageManager,
    PythonEnvironment,
    PythonProject,
} from './types.js';

/** Capabilities that an environment manager can provide. */
export const EnvironmentCapability = {
    /** Discover the environments available within a scope. */
    List: 'environments.list',
    /** Resolve a URI to its corresponding Python environment. */
    Resolve: 'environments.resolve',
    /** Get the Python environment selected for a scope. */
    GetSelected: 'environments.getSelected',
    /** Select or clear the Python environment for a scope. */
    SetSelected: 'environments.setSelected',
    /** Create a new Python environment. */
    Create: 'environments.create',
    /** Create an environment with an exact caller-supplied name; unsupported unless explicitly advertised. */
    CreateNamed: 'environment.create.named',
    /** Remove an existing Python environment. */
    Remove: 'environments.remove',
} as const;

/** Capabilities that a package manager can provide. */
export const PackageCapability = {
    /** List the packages installed in an environment. */
    List: 'packages.list',
    /** Install packages into an environment. */
    Install: 'packages.install',
    /** Uninstall packages from an environment. */
    Uninstall: 'packages.uninstall',
    /** Upgrade packages in an environment. */
    Upgrade: 'packages.upgrade',
    /** List the packages that are direct dependencies of an environment. */
    ListDirect: 'packages.list.direct',
    /** List the versions available for a package. */
    FetchAvailableVersions: 'packages.fetchversions',
} as const;

/** Environment capability keys for manager advertisements. */
export type EnvironmentManagerCapability = (typeof EnvironmentCapability)[keyof typeof EnvironmentCapability];

/** Package capability keys for manager advertisements. */
export type PackageManagerCapability = (typeof PackageCapability)[keyof typeof PackageCapability];

type ManagerCapability = EnvironmentManagerCapability | PackageManagerCapability;
const environmentCapabilityKeys = Object.values(EnvironmentCapability);
const packageCapabilityKeys = Object.values(PackageCapability);

/**
 * Identifies catalog keys so telemetry does not record arbitrary runtime input.
 * @param capability Runtime value supplied by a caller.
 */
export function isKnownManagerCapability(capability: unknown): capability is ManagerCapability {
    return (
        environmentCapabilityKeys.some((key) => key === capability) ||
        packageCapabilityKeys.some((key) => key === capability)
    );
}

/** General feature support, not a guarantee that a particular operation will succeed. */
export type Support = ({ readonly supported: true } | { readonly supported: false; readonly reason: string }) & {
    /** Whether support was inferred from legacy methods. Omitted means false. */
    readonly isLegacy?: boolean;
};

/** Context for a support query. Operation arguments and request validation are intentionally excluded. */
export interface CapabilityContext {
    readonly scope?: CreateEnvironmentScope | GetEnvironmentsScope;
    readonly environment?: PythonEnvironment;
    readonly project?: PythonProject;
}

/** A read-only, noninteractive check. Unexpected probe failures should reject, not report unsupported. */
export type CapabilityCheck = (context: CapabilityContext) => Promise<Support>;

/** Every capability key must be advertised as a read-only, noninteractive check; there are no defaults. */
export type Capabilities<C extends ManagerCapability> = Readonly<Record<C, CapabilityCheck>>;

/** A capability check that always reports support. Use for unconditionally supported operations. */
export const supportedCapability: CapabilityCheck = async () => ({ supported: true });

/** A capability check that reports unsupported with the generic "not implemented" reason. */
export const unsupportedCapability: CapabilityCheck = async () => ({
    supported: false,
    reason: l10n.t('Capability not implemented'),
});

/**
 * Resolves environment-manager support without invoking the operation or prompting.
 * @param manager Manager whose advertised capabilities are queried.
 * @param capability Environment capability to look up; missing keys in a supplied map resolve unsupported.
 * @param context Context forwarded unchanged to the advertised check.
 * @returns Advertised support, or legacy method inference when the map is omitted. Probe errors reject.
 */
export function resolveEnvironmentManagerCapability(
    manager: EnvironmentManager,
    capability: EnvironmentManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    if (manager.capabilities === undefined) {
        return getLegacyEnvironmentManagerCapability(manager, capability);
    }
    return resolveCapability(manager, capability, context);
}

/**
 * Resolves package-manager support without invoking the operation or prompting.
 * @param manager Manager whose advertised capabilities are queried, including the project-bound instance when applicable.
 * @param capability Package capability to look up; missing keys in a supplied map resolve unsupported.
 * @param context Context forwarded unchanged to the advertised check.
 * @returns Advertised support, or legacy method inference when the map is omitted. Probe errors reject.
 */
export function resolvePackageManagerCapability(
    manager: PackageManager,
    capability: PackageManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    if (manager.capabilities === undefined) {
        return getLegacyPackageManagerCapability(manager, capability);
    }
    return resolveCapability(manager, capability, context);
}

async function resolveCapability<C extends ManagerCapability>(
    manager: { readonly capabilities?: Capabilities<C> },
    capability: C,
    context: CapabilityContext,
): Promise<Support> {
    const capabilities = manager.capabilities;
    const check =
        capabilities && Object.prototype.hasOwnProperty.call(capabilities, capability)
            ? capabilities[capability]
            : undefined;
    return typeof check === 'function' ? check(context) : unsupportedCapability(context);
}
