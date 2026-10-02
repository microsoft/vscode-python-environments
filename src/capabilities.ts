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

/** Supported environment capability keys. Adding a key also requires defining its default. */
export type EnvironmentCapability =
    | 'environments.list' // List known environments for a scope.
    | 'environments.refresh' // Rediscover environments for a scope.
    | 'environments.resolve' // Resolve an interpreter or environment URI into an environment.
    | 'environments.getSelected' // Read the selected environment for a scope.
    | 'environments.setSelected' // Set or clear the selected environment for a scope.
    | 'environments.create' // Create an environment.
    | 'environments.create.quick' // Offer a quick creation path; some requests may still prompt.
    | 'environments.create.additionalPackages' // Install extra packages in a supported creation mode.
    | 'environments.remove' // Delete an environment.
    | 'environments.remove.headless' // Delete without confirmation or input prompts.
    | 'environments.clearCache' // Clear the manager's cached environment data.
    | 'environments.events.changed' // Emit provider notifications when environments change.
    | 'environments.events.selectionChanged'; // Emit provider notifications when selection changes.

/** Supported package capability keys. Adding a key also requires defining its default. */
export type PackageCapability =
    | 'packages.list' // List installed packages in an environment.
    | 'packages.list.skipCache' // Retrieve installed packages without using cached results.
    | 'packages.refresh' // Refresh installed package data.
    | 'packages.manage' // Execute package management requests.
    | 'packages.manage.install' // Install the requested packages.
    | 'packages.manage.uninstall' // Uninstall the requested packages.
    | 'packages.manage.upgrade' // Honor the upgrade option during installation.
    | 'packages.manage.headless' // Manage packages without confirmation or input prompts.
    | 'packages.manage.showSkipOption' // Offer a skip choice during interactive package selection.
    | 'packages.direct' // Identify direct versus transitive packages on a best-effort basis.
    | 'packages.version' // Report the package-manager tool version.
    | 'packages.availableVersions' // Look up available versions of a package.
    | 'packages.formatInstallSpec' // Format a version-pinned install specifier, including the default fallback.
    | 'packages.clearCache' // Clear the manager's cached package data.
    | 'packages.watchTargets' // Supply custom filesystem patterns for package-change watching.
    | 'packages.events.changed'; // Emit provider notifications when packages change.

export type ManagerCapability = EnvironmentCapability | PackageCapability;

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

/** Shared defaults inspect the raw provider, not wrapper-supplied fallback methods. */
export type DefaultCapabilityCheck<M> = (manager: M, context: CapabilityContext) => Promise<Support>;

/**
 * Environment capability catalog and compatibility defaults.
 * Optional hooks are inspected without invoking them. Options inherit their parent's effective support.
 */
export const defaultEnvironmentCapabilities = Object.freeze({
    /** getEnvironments: required. An empty result is valid. */
    'environments.list': async (_manager, _context) => supportIf(true),
    /** refresh: required. */
    'environments.refresh': async (_manager, _context) => supportIf(true),
    /** resolve: required. Finding no environment is valid; pass the target URI as scope. */
    'environments.resolve': async (_manager, _context) => supportIf(true),
    /** get: required. No selected environment is valid. */
    'environments.getSelected': async (_manager, _context) => supportIf(true),
    /** set: required, including clearing the selection. */
    'environments.setSelected': async (_manager, _context) => supportIf(true),
    /** create: optional raw method. */
    'environments.create': async (manager, _context) => supportIf(typeof manager.create === 'function'),
    /** Availability of the quick path, not a guarantee that every request is prompt-free. */
    'environments.create.quick': async (manager, context): Promise<Support> => {
        const create = await resolveEnvironmentManagerCapability(manager, 'environments.create', context);
        return create.supported ? supportIf(typeof manager.quickCreateConfig === 'function') : create;
    },
    /** Additional packages in a documented creation mode, not necessarily every mode. */
    'environments.create.additionalPackages': async (manager, context): Promise<Support> =>
        resolveEnvironmentManagerCapability(manager, 'environments.create', context),
    /** remove: optional raw method. */
    'environments.remove': async (manager, _context) => supportIf(typeof manager.remove === 'function'),
    /** Removal without confirmation/input; progress and error UI are not suppressed. */
    'environments.remove.headless': async (manager, context): Promise<Support> =>
        resolveEnvironmentManagerCapability(manager, 'environments.remove', context),
    /** clearCache: optional raw method. */
    'environments.clearCache': async (manager, _context) => supportIf(typeof manager.clearCache === 'function'),
    /** Provider notifications, not events synthesized by the extension. */
    'environments.events.changed': async (manager, _context) =>
        supportIf(typeof manager.onDidChangeEnvironments === 'function'),
    /** Provider selection notifications, not events synthesized by the extension. */
    'environments.events.selectionChanged': async (manager, _context) =>
        supportIf(typeof manager.onDidChangeEnvironment === 'function'),
} satisfies Record<EnvironmentCapability, DefaultCapabilityCheck<EnvironmentManager>>);

/**
 * Package capability catalog and compatibility defaults.
 * Legacy option support is optimistic; explicit manager advertisements can refine or disable it.
 */
export const defaultPackageCapabilities = Object.freeze({
    /** getPackages: required. An empty result is valid. */
    'packages.list': async (_manager, _context) => supportIf(true),
    /** Fresh retrieval; does not require a separate cache implementation. */
    'packages.list.skipCache': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.list', context),
    /** refresh: required. */
    'packages.refresh': async (_manager, _context) => supportIf(true),
    /** manage: required; individual operation variants have their own keys. */
    'packages.manage': async (_manager, _context) => supportIf(true),
    /** Honor the install array. */
    'packages.manage.install': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Honor the uninstall array. */
    'packages.manage.uninstall': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Honor upgrade for installation, without guaranteeing identical solver behavior. */
    'packages.manage.upgrade': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage.install', context),
    /** No confirmation/pickers, including when installation arrays are empty. */
    'packages.manage.headless': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Offer skip during interactive package selection, when applicable. */
    'packages.manage.showSkipOption': async (manager, context): Promise<Support> =>
        resolvePackageManagerCapability(manager, 'packages.manage', context),
    /** Best-effort direct/transitive classification, not exact user installation intent. */
    'packages.direct': async (manager, _context) => supportIf(typeof manager.getDirectPackageNames === 'function'),
    /** Package-manager tool version, not Python or an installed package's version. */
    'packages.version': async (manager, _context) => supportIf(typeof manager.getVersion === 'function'),
    /** Available package versions; presence inference may be refined for tool/version restrictions. */
    'packages.availableVersions': async (manager, _context) =>
        supportIf(typeof manager.getPackageAvailableVersions === 'function'),
    /** Supported through the extension's name==version fallback even without a custom formatter. */
    'packages.formatInstallSpec': async (_manager, _context) => supportIf(true),
    /** clearCache: optional raw method. */
    'packages.clearCache': async (manager, _context) => supportIf(typeof manager.clearCache === 'function'),
    /** Custom watch patterns, not general package-change watching. */
    'packages.watchTargets': async (manager, _context) =>
        supportIf(typeof manager.getPackageWatchTargets === 'function'),
    /** Provider notifications, not extension-owned watchers or synthesized events. */
    'packages.events.changed': async (manager, _context) => supportIf(typeof manager.onDidChangePackages === 'function'),
} satisfies Record<PackageCapability, DefaultCapabilityCheck<PackageManager>>);

/**
 * Resolves general environment-manager support without invoking the operation or prompting.
 * @param manager Raw provider whose advertisements override the external defaults.
 * @param capability Environment capability to query; unknown runtime keys resolve unsupported.
 * @param context Query context. Forward the received context unchanged when checking prerequisites.
 * @returns Support, including a reason when unsupported. Probe errors and dependency cycles reject.
 */
export function resolveEnvironmentManagerCapability(
    manager: EnvironmentManager,
    capability: EnvironmentCapability,
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
    capability: PackageCapability,
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
    return check ? check(nextContext) : defaults[capability](manager, nextContext);
}
