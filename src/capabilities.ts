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

/**
 * Environment capability keys. Every environment manager must advertise a check for each key.
 */
const environmentCapabilityKeys = [
    /** List known environments for a scope. Required getEnvironments operation; an empty result is valid. */
    'environments.list',
    /** Rediscover environments for a scope. Required refresh operation. */
    'environments.refresh',
    /** Resolve an interpreter or environment URI. Required resolve operation; pass the target URI as scope. */
    'environments.resolve',
    /** Read the selected environment for a scope. Required get operation; no selection is valid. */
    'environments.getSelected',
    /** Set or clear the selected environment for a scope. Required set operation. */
    'environments.setSelected',
    /** Create an environment. */
    'environments.create',
    /** Offer a quick creation path; requests may still prompt. */
    'environments.create.quick',
    /** Delete an environment. */
    'environments.remove',
] as const;

/**
 * Package capability keys. Every package manager must advertise a check for each key.
 */
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

const environmentCapabilityKeySet: ReadonlySet<string> = new Set(environmentCapabilityKeys);
const packageCapabilityKeySet: ReadonlySet<string> = new Set(packageCapabilityKeys);

/** Environment capability keys that every environment manager must advertise a check for. */
export type EnvironmentManagerCapability = (typeof environmentCapabilityKeys)[number];

/** Package capability keys that every package manager must advertise a check for. */
export type PackageManagerCapability = (typeof packageCapabilityKeys)[number];

type ManagerCapability = EnvironmentManagerCapability | PackageManagerCapability;

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

/**
 * A capability check that always reports the generic "not implemented" reason. Use when a manager
 * has no reason more specific than "unsupported"; otherwise return a custom `{ supported: false, reason }`.
 */
export const unsupportedCapability: CapabilityCheck = async () => ({
    supported: false,
    reason: l10n.t('Capability not implemented'),
});

/**
 * Resolves environment-manager support without invoking the operation or prompting.
 * @param manager Manager whose advertised capabilities are queried.
 * @param capability Environment capability to query; unknown runtime keys resolve unsupported.
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
 * @returns Support, including a reason when unsupported. Probe errors and dependency cycles reject.
 */
export function resolveEnvironmentManagerCapability(
    manager: EnvironmentManager,
    capability: EnvironmentManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context, environmentCapabilityKeySet);
}

/**
 * Resolves package-manager support without invoking the operation or prompting.
 * @param manager Manager whose advertised capabilities are queried, including the project-bound instance when applicable.
 * @param capability Package capability to query; unknown runtime keys resolve unsupported.
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
 * @returns Support, including a reason when unsupported. Probe errors and dependency cycles reject.
 */
export function resolvePackageManagerCapability(
    manager: PackageManager,
    capability: PackageManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context, packageCapabilityKeySet);
}

// A shared symbol preserves ancestry across separately bundled copies of this public module.
const ancestryKey = Symbol.for('@vscode/python-environments/capabilityAncestry/v1');

interface EvaluationContext extends CapabilityContext {
    readonly [ancestryKey]?: readonly { readonly manager: object; readonly capability: ManagerCapability }[];
}

function supportIf(supported: boolean): Support {
    return supported ? { supported: true } : { supported: false, reason: l10n.t('Capability not implemented') };
}

async function resolveCapability<M extends { readonly capabilities: Capabilities<C> }, C extends ManagerCapability>(
    manager: M,
    capability: C,
    context: EvaluationContext,
    validKeys: ReadonlySet<string>,
): Promise<Support> {
    if (!validKeys.has(capability)) {
        return supportIf(false);
    }
    const ancestry = context[ancestryKey] ?? [];
    if (ancestry.some((entry) => entry.manager === manager && entry.capability === capability)) {
        throw new Error(
            `Capability dependency cycle: ${[...ancestry.map((entry) => entry.capability), capability].join(' -> ')}`,
        );
    }
    const nextContext: EvaluationContext = Object.defineProperty({ ...context }, ancestryKey, {
        value: [...ancestry, { manager, capability }],
        enumerable: true,
    });
    const advertised: unknown = manager.capabilities;
    if (!isCapabilityRecord(advertised)) {
        throw new TypeError(l10n.t('Manager capabilities must be an object.'));
    }
    const check = Object.prototype.hasOwnProperty.call(advertised, capability) ? advertised[capability] : undefined;
    if (check === undefined) {
        return supportIf(false);
    }
    if (typeof check !== 'function') {
        throw new TypeError(l10n.t('Capability {0} must be advertised as a function.', capability));
    }
    return check(nextContext);
}

function isCapabilityRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
