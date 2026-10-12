import type {
    Capabilities,
    CapabilityContext,
    EnvironmentManager,
    EnvironmentManagerCapability,
    PackageManager,
    PackageManagerCapability,
    Pep440Version,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonPackageGetterApi,
    Support,
} from '@vscode/python-environments';
import {
    EnvironmentCapability,
    isPackageVersionLookupNotSupportedError,
    PackageCapability,
    PackageVersionLookupNotSupportedError,
    PythonEnvironments,
    resolveEnvironmentManagerCapability,
    resolvePackageManagerCapability,
    supportedCapability,
} from '@vscode/python-environments';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

// Compile-only fixture shared by modern and legacy consumers; not executed.
declare const api: PythonEnvironmentApi;
declare const environment: PythonEnvironment;
PythonEnvironments.api() satisfies Promise<PythonEnvironmentApi>;

// Package version lookup contracts.
type AvailableVersionsReturn = ReturnType<PythonPackageGetterApi['getPackageAvailableVersions']>;
type RefreshReturn = ReturnType<PackageManager['refresh']>;

true satisfies Equal<AvailableVersionsReturn, Promise<Pep440Version[] | undefined>>;
true satisfies Equal<RefreshReturn, Promise<void>>;

api.getPackageAvailableVersions(environment, 'example') satisfies Promise<Pep440Version[] | undefined>;
api.getPackageAvailableVersions(environment, 'example', {
    errorMode: 'legacy',
}) satisfies Promise<Pep440Version[] | undefined>;
api.getPackageAvailableVersions(environment, 'example', { errorMode: 'throw' }) satisfies Promise<Pep440Version[]>;

// Public error construction, discriminator, and narrowing.
const lookupError = new PackageVersionLookupNotSupportedError('unsupported');
lookupError satisfies Error;
true satisfies Equal<typeof lookupError.code, 'PackageVersionLookupNotSupported'>;

declare const maybeError: unknown;
if (isPackageVersionLookupNotSupportedError(maybeError)) {
    maybeError.code satisfies 'PackageVersionLookupNotSupported';
}

// Legacy providers may omit advertisements; advertised maps must include every key without defaults.
const fullPackageCapabilities: Capabilities<PackageManagerCapability> = {
    [PackageCapability.List]: supportedCapability,
    [PackageCapability.Install]: supportedCapability,
    [PackageCapability.Uninstall]: supportedCapability,
    [PackageCapability.Upgrade]: supportedCapability,
    [PackageCapability.ListDirect]: supportedCapability,
    [PackageCapability.ListAvailableVersions]: supportedCapability,
};
const fullEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    [EnvironmentCapability.List]: supportedCapability,
    [EnvironmentCapability.Resolve]: supportedCapability,
    [EnvironmentCapability.GetSelected]: supportedCapability,
    [EnvironmentCapability.SetSelected]: supportedCapability,
    [EnvironmentCapability.Create]: supportedCapability,
    [EnvironmentCapability.Remove]: supportedCapability,
};

const legacyPackageManager: PackageManager = {
    name: 'legacy',
    manage: async () => {},
    refresh: async () => {},
    getPackages: async () => [],
};
const legacyEnvironmentManager: EnvironmentManager = {
    name: 'legacy',
    preferredPackageManagerId: 'example:legacy',
    refresh: async () => {},
    getEnvironments: async () => [],
    get: async () => undefined,
    set: async () => {},
    resolve: async () => undefined,
};

// Capability authoring and raw-provider resolution.
const advertised: Capabilities<PackageManagerCapability> = {
    ...fullPackageCapabilities,
    [PackageCapability.Upgrade]: (context: CapabilityContext) =>
        resolvePackageManagerCapability(legacyPackageManager, PackageCapability.Install, context),
    [PackageCapability.ListDirect]: async (_context) => ({ supported: false, reason: 'Unavailable' }),
};
const managerWithCapabilities: PackageManager = { ...legacyPackageManager, capabilities: advertised };
resolvePackageManagerCapability(managerWithCapabilities, PackageCapability.ListDirect, { environment }) satisfies Promise<Support>;
resolveEnvironmentManagerCapability(legacyEnvironmentManager, EnvironmentCapability.Create, {
    scope: 'global',
}) satisfies Promise<Support>;

// Public queries and support-result narrowing.
api.getPackageManagerCapability(environment, PackageCapability.List) satisfies Promise<Support>;
api.getEnvironmentManagerCapability('example:legacy', EnvironmentCapability.List, { scope: 'all' }) satisfies Promise<Support>;
declare const support: Support;
if (!support.supported) {
    support.reason satisfies string;
}

// Invalid capability keys, advertisements, and context must remain compile errors.
// @ts-expect-error Package keys do not belong to the environment capability domain.
PackageCapability.List satisfies EnvironmentManagerCapability;
// @ts-expect-error Environment keys do not belong to the package capability domain.
EnvironmentCapability.List satisfies PackageManagerCapability;
// @ts-expect-error Advertisements must be asynchronous functions, not static Support values.
({ [PackageCapability.List]: { supported: true } } satisfies Capabilities<PackageManagerCapability>);
// @ts-expect-error Advertisements cannot introduce arbitrary keys.
({ 'packages.unknown': async () => ({ supported: true }) } satisfies Capabilities<PackageManagerCapability>);
// @ts-expect-error Operation options are not capability query context.
({ createOptions: { quickCreate: true } } satisfies CapabilityContext);
declare const arbitraryKey: string;
// @ts-expect-error A general string is not a declared environment capability.
resolveEnvironmentManagerCapability(legacyEnvironmentManager, arbitraryKey);
// @ts-expect-error A general string is not a declared package capability.
resolvePackageManagerCapability(legacyPackageManager, arbitraryKey);
// @ts-expect-error Public environment queries require a catalog key.
api.getEnvironmentManagerCapability('example:legacy', arbitraryKey);
// @ts-expect-error Public package queries require a catalog key.
api.getPackageManagerCapability(environment, arbitraryKey);
// @ts-expect-error Capability dictionaries have no arbitrary string index signature.
fullPackageCapabilities[arbitraryKey];
// @ts-expect-error Capability dictionaries have no arbitrary string index signature.
fullEnvironmentCapabilities[arbitraryKey];
// @ts-expect-error Capability dictionaries must advertise every catalog key; partial maps are rejected.
({ [PackageCapability.List]: async () => ({ supported: true }) } satisfies Capabilities<PackageManagerCapability>);
