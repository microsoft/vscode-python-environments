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

// ---------------------------------------------------------------------------
// Capability catalogs
//
// The catalogs below are the single source of truth for which capability keys exist. Every
// environment/package manager must advertise a check for each key in its catalog; there are no
// defaults, so unimplemented capabilities must advertise `unsupportedCapability` explicitly.
// ---------------------------------------------------------------------------

/** Environment capability keys. Every environment manager must advertise a check for each key. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only used via `typeof` below to derive the union type.
const environmentCapabilityKeys = [
    /** List/rediscover known environments for a scope. Required getEnvironments and refresh operations. */
    'environments.list',
    /** Resolve an interpreter or environment URI. Required resolve operation; pass the target URI as scope. */
    'environments.resolve',
    /** Read the selected environment for a scope. Required get operation; no selection is valid. */
    'environments.getSelected',
    /** Set or clear the selected environment for a scope. Required set operation. */
    'environments.setSelected',
    /** Create an environment. */
    'environments.create',
    /** Delete an environment. */
    'environments.remove',
] as const;

/** Package capability keys. Every package manager must advertise a check for each key. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only used via `typeof` below to derive the union type.
const packageCapabilityKeys = [
    /** List installed packages in an environment. Required getPackages operation; an empty result is valid. */
    'packages.list',
    /** Refresh installed package data. Required refresh operation. */
    'packages.refresh',
    /** Execute package management requests. Required manage operation; variants have their own keys. */
    'packages.manage',
    /** Install the requested packages by honoring the install array. */
    'packages.manage.install',
    /** Uninstall the requested packages by honoring the uninstall array. */
    'packages.manage.uninstall',
    /** Honor upgrade for installation, without guaranteeing identical solver behavior. */
    'packages.manage.upgrade',
    /** Identify direct/transitive packages on a best-effort basis, not exact user installation intent. */
    'packages.direct',
    /** Look up available package versions. */
    'packages.availableVersions',
] as const;

/** Environment capability keys that every environment manager must advertise a check for. */
export type EnvironmentManagerCapability = (typeof environmentCapabilityKeys)[number];

/** Package capability keys that every package manager must advertise a check for. */
export type PackageManagerCapability = (typeof packageCapabilityKeys)[number];

type ManagerCapability = EnvironmentManagerCapability | PackageManagerCapability;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared capability checks
//
// Convenience constants for the two most common advertisements, so managers don't need to write
// out `async () => ({ supported: ... })` by hand for unconditional or unimplemented capabilities.
// ---------------------------------------------------------------------------

/** A capability check that always reports support. Use for unconditionally supported operations. */
export const supportedCapability: CapabilityCheck = async () => ({ supported: true });

/**
 * A capability check that always reports the generic "not implemented" reason. Use when a manager
 * has no reason more specific than "unsupported"; otherwise return a custom `{ supported: false, reason }`.
 */
export const unsupportedCapability: CapabilityCheck = async () => ({
    supported: false,
    reason: l10n.t('Capability not implemented'),
});

// ---------------------------------------------------------------------------
// Public resolvers
//
// These are the only two entry points managers and API callers should use. Each pins a manager
// type to its matching capability-key type, so a capability key for the wrong kind of manager is
// a compile error rather than a silent runtime mismatch.
//
// Callers include both the API layer and managers themselves, which may call these recursively
// from within a capability check to delegate to a prerequisite (e.g. `'packages.manage.install'`
// delegating to `'packages.manage'`). There is no cycle protection: a manager that delegates
// in a loop will recurse until the call stack overflows, so keep delegation chains acyclic.
// ---------------------------------------------------------------------------

/**
 * Resolves environment-manager support without invoking the operation or prompting.
 * @param manager Manager whose advertised capabilities are queried.
 * @param capability Environment capability to look up; keys the manager hasn't advertised resolve unsupported.
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
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
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
 * @returns Support, including a reason when unsupported. Probe errors reject.
 */
export function resolvePackageManagerCapability(
    manager: PackageManager,
    capability: PackageManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context);
}

// ---------------------------------------------------------------------------
// Resolution engine (internal)
// ---------------------------------------------------------------------------

/**
 * Looks up `capability` as the manager's own advertised property and calls it if present.
 * Anything else - a missing key, an inherited property (e.g. `toString`), or a declared value
 * that isn't a function - resolves unsupported rather than invoking anything.
 */
async function resolveCapability<M extends { readonly capabilities: Capabilities<C> }, C extends ManagerCapability>(
    manager: M,
    capability: C,
    context: CapabilityContext,
): Promise<Support> {
    const check = Object.prototype.hasOwnProperty.call(manager.capabilities, capability)
        ? manager.capabilities[capability]
        : undefined;
    return typeof check === 'function' ? check(context) : unsupportedCapability(context);
}
