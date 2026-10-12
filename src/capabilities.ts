// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';
import type {
    CreateEnvironmentScope,
    EnvironmentManager,
    GetEnvironmentsScope,
    PackageManager,
    PythonEnvironment,
    PythonProject,
} from './types.js';

/** Environment capability keys. Advertised maps must include a check for each key. */
export const EnvironmentCapability = {
    /** List/rediscover known environments for a scope. Required getEnvironments and refresh operations. */
    List: 'environments.list',
    /** Resolve an interpreter or environment URI. Required resolve operation; pass the target URI as scope. */
    Resolve: 'environments.resolve',
    /** Read the selected environment for a scope. Required get operation; no selection is valid. */
    GetSelected: 'environments.getSelected',
    /** Set or clear the selected environment for a scope. Required set operation. */
    SetSelected: 'environments.setSelected',
    /** Create an environment. */
    Create: 'environments.create',
    /** Delete an environment. */
    Remove: 'environments.remove',
} as const;

/** Package capability keys. Advertised maps must include a check for each key. */
export const PackageCapability = {
    /** List/refresh installed packages in an environment. Required getPackages and refresh operations; an empty result is valid. */
    List: 'packages.list',
    /** Install the requested packages by honoring the install array. */
    Install: 'packages.install',
    /** Uninstall the requested packages by honoring the uninstall array. */
    Uninstall: 'packages.uninstall',
    /** Honor upgrade for installation, without guaranteeing identical solver behavior. */
    Upgrade: 'packages.upgrade',
    /** List direct package names on a best-effort basis, not exact user installation intent. */
    ListDirect: 'packages.listDirect',
    /** Look up available package versions. */
    ListAvailableVersions: 'packages.listAvailableVersions',
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
    return environmentCapabilityKeys.some((key) => key === capability) ||
        packageCapabilityKeys.some((key) => key === capability);
}

/** General feature support, not a guarantee that a particular operation will succeed. */
export type Support = { readonly supported: true } | { readonly supported: false; readonly reason: string };

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
 * @param capability Environment capability to look up; keys the manager hasn't advertised resolve unsupported.
 * @param context Context forwarded unchanged to the advertised check.
 * @returns Support, including a reason when unsupported. Probe errors reject.
 */
export function resolveEnvironmentManagerCapability(
    manager: EnvironmentManager,
    capability: EnvironmentManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context);
}

/**
 * Resolves package-manager support without invoking the operation or prompting.
 * @param manager Manager whose advertised capabilities are queried, including the project-bound instance when applicable.
 * @param capability Package capability to look up; keys the manager hasn't advertised resolve unsupported.
 * @param context Context forwarded unchanged to the advertised check.
 * @returns Support, including a reason when unsupported. Probe errors reject.
 */
export function resolvePackageManagerCapability(
    manager: PackageManager,
    capability: PackageManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context);
}

async function resolveCapability<C extends ManagerCapability>(
    manager: { readonly capabilities?: Capabilities<C> },
    capability: C,
    context: CapabilityContext,
): Promise<Support> {
    const capabilities = manager.capabilities;
    const check = capabilities && Object.prototype.hasOwnProperty.call(capabilities, capability)
        ? capabilities[capability]
        : undefined;
    return typeof check === 'function' ? check(context) : unsupportedCapability(context);
}
