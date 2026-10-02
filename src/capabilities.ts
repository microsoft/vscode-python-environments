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

/** Environment capability keys derived from the canonical default dictionary. */
export type EnvironmentManagerCapability = keyof typeof defaultEnvironmentCapabilities;

/** Package capability keys derived from the canonical default dictionary. */
export type PackageManagerCapability = keyof typeof defaultPackageCapabilities;

type ManagerCapability = EnvironmentManagerCapability | PackageManagerCapability;

/** General feature support, not a guarantee that a particular operation will succeed. */
export type Support =
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: string };

/** Context for a support query. Operation arguments and request validation are intentionally excluded. */
export interface CapabilityContext {
    readonly scope?: CreateEnvironmentScope | GetEnvironmentsScope;
    readonly environment?: PythonEnvironment;
    readonly project?: PythonProject;
}

/** A read-only, noninteractive check. Unexpected probe failures should reject, not report unsupported. */
export type CapabilityCheck = (context: CapabilityContext) => Promise<Support>;

/** Advertise only overrides; absent entries are resolved through the external default dictionaries. */
export type Capabilities<C extends ManagerCapability> = Readonly<Partial<Record<C, CapabilityCheck>>>;

/** Shared defaults use the raw provider when resolving advertised prerequisites. */
type DefaultCapabilityCheck<M> = (manager: M, context: CapabilityContext) => Promise<Support>;

/**
 * Environment capability catalog and compatibility defaults.
 * Optional methods/events follow raw hook availability; existing options inherit their parent's
 * effective support. Quick creation also requires the legacy create and quickCreateConfig hooks.
 */
export const defaultEnvironmentCapabilities = Object.freeze({
    /** List known environments for a scope. Required getEnvironments operation; an empty result is valid. */
    'environments.list': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Rediscover environments for a scope. Required refresh operation. */
    'environments.refresh': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Resolve an interpreter or environment URI. Required resolve operation; pass the target URI as scope. */
    'environments.resolve': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Read the selected environment for a scope. Required get operation; no selection is valid. */
    'environments.getSelected': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Set or clear the selected environment for a scope. Required set operation. */
    'environments.setSelected': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Create an environment when the raw provider implements create. */
    'environments.create': async (manager, _context): Promise<Support> => supportIf(typeof manager.create === 'function'),
    /** Offer a quick creation path via legacy hooks. Explicit overrides may use other hooks; requests may still prompt. */
    'environments.create.quick': async (manager, context): Promise<Support> =>
        typeof manager.create === 'function' && typeof manager.quickCreateConfig === 'function'
            ? resolveEnvironmentManagerCapability(manager, 'environments.create', context)
            : supportIf(false),
    /** Install extra packages in a documented creation mode, not necessarily every mode. */
    'environments.create.additionalPackages': async (manager, context): Promise<Support> =>
        resolveEnvironmentManagerCapability(manager, 'environments.create', context),
    /** Delete an environment when the raw provider implements remove. */
    'environments.remove': async (manager, _context): Promise<Support> => supportIf(typeof manager.remove === 'function'),
    /** Delete without confirmation/input; progress and error UI are not suppressed. */
    'environments.remove.headless': async (manager, context): Promise<Support> =>
        resolveEnvironmentManagerCapability(manager, 'environments.remove', context),
    /** Clear the manager's cached environment data through its optional clearCache operation. */
    'environments.clearCache': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.clearCache === 'function'),
    /** Emit provider notifications when environments change, not events synthesized by the extension. */
    'environments.events.changed': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.onDidChangeEnvironments === 'function'),
    /** Emit provider selection notifications, not events synthesized by the extension. */
    'environments.events.selectionChanged': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.onDidChangeEnvironment === 'function'),
} satisfies Record<string, DefaultCapabilityCheck<EnvironmentManager>>);

/**
 * Package capability catalog and compatibility defaults.
 * Optional methods/events follow raw hook availability. Legacy option support is optimistic;
 * explicit manager advertisements can refine or disable either inference.
 */
export const defaultPackageCapabilities = Object.freeze({
    /** List installed packages in an environment. Required getPackages operation; an empty result is valid. */
    'packages.list': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Retrieve installed packages without cached results; does not require a separate cache implementation. */
    'packages.list.skipCache': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.list', context),
    /** Refresh installed package data. Required refresh operation. */
    'packages.refresh': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Execute package management requests. Required manage operation; variants have their own keys. */
    'packages.manage': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Install the requested packages by honoring the install array. */
    'packages.manage.install': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Uninstall the requested packages by honoring the uninstall array. */
    'packages.manage.uninstall': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Honor upgrade for installation, without guaranteeing identical solver behavior. */
    'packages.manage.upgrade': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage.install', context),
    /** Manage packages without confirmation/input, including when installation arrays are empty. */
    'packages.manage.headless': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Offer skip during interactive package selection, when applicable. */
    'packages.manage.showSkipOption': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Identify direct/transitive packages on a best-effort basis, not exact user installation intent. */
    'packages.direct': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.getDirectPackageNames === 'function'),
    /** Report the package-manager tool version, not Python or an installed package's version. */
    'packages.version': async (manager, _context): Promise<Support> => supportIf(typeof manager.getVersion === 'function'),
    /** Look up available package versions; advertisements refine unsupported stubs and tool/version restrictions. */
    'packages.availableVersions': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.getPackageAvailableVersions === 'function'),
    /** Format a version-pinned install specifier, using the extension's name==version fallback if needed. */
    'packages.formatInstallSpec': async (_manager, _context): Promise<Support> => supportIf(true),
    /** Clear the manager's cached package data through its optional clearCache operation, not an extension fallback. */
    'packages.clearCache': async (manager, _context): Promise<Support> => supportIf(typeof manager.clearCache === 'function'),
    /** Supply custom filesystem patterns for package-change watching, not general watching. */
    'packages.watchTargets': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.getPackageWatchTargets === 'function'),
    /** Emit provider notifications when packages change, not extension-owned watchers or synthesized events. */
    'packages.events.changed': async (manager, _context): Promise<Support> =>
        supportIf(typeof manager.onDidChangePackages === 'function'),
} satisfies Record<string, DefaultCapabilityCheck<PackageManager>>);

/**
 * Resolves general environment-manager support without invoking the operation or prompting.
 * @param manager Raw provider whose advertisements override the external defaults.
 * @param capability Environment capability to query; unknown runtime keys resolve unsupported.
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
 * @returns Support, including a reason when unsupported. Probe errors and dependency cycles reject.
 */
export function resolveEnvironmentManagerCapability(
    manager: EnvironmentManager,
    capability: EnvironmentManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context, defaultEnvironmentCapabilities);
}

/**
 * Resolves general package-manager support without invoking the operation or prompting.
 * @param manager Raw provider, including the project-bound instance when applicable.
 * @param capability Package capability to query; unknown runtime keys resolve unsupported.
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
 * @returns Support, including a reason when unsupported. Probe errors and dependency cycles reject.
 */
export function resolvePackageManagerCapability(
    manager: PackageManager,
    capability: PackageManagerCapability,
    context: CapabilityContext = {},
): Promise<Support> {
    return resolveCapability(manager, capability, context, defaultPackageCapabilities);
}

// A shared symbol preserves ancestry across separately bundled copies of this public module.
const ancestryKey = Symbol.for('@vscode/python-environments/capabilityAncestry/v1');

interface EvaluationContext extends CapabilityContext {
    readonly [ancestryKey]?: readonly { readonly manager: object; readonly capability: ManagerCapability }[];
}

function supportIf(supported: boolean): Support {
    return supported ? { supported: true } : { supported: false, reason: l10n.t('Capability not implemented') };
}

async function resolveCapability<M extends { readonly capabilities?: Capabilities<C> }, C extends ManagerCapability>(
    manager: M,
    capability: C,
    context: EvaluationContext,
    defaults: Readonly<Record<C, DefaultCapabilityCheck<M>>>,
): Promise<Support> {
    if (!Object.prototype.hasOwnProperty.call(defaults, capability)) {
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
    });
    const advertised = manager.capabilities;
    const check =
        advertised && Object.prototype.hasOwnProperty.call(advertised, capability)
            ? advertised[capability]
            : undefined;
    if (check === undefined) {
        return defaults[capability](manager, nextContext);
    }
    if (typeof check !== 'function') {
        throw new TypeError(l10n.t('Capability {0} must be advertised as a function.', capability));
    }
    return check(nextContext);
}
