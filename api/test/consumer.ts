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
    isPackageVersionLookupNotSupportedError,
    PackageVersionLookupNotSupportedError,
    PythonEnvironments,
    resolveEnvironmentManagerCapability,
    resolvePackageManagerCapability,
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

// Legacy providers must now advertise every capability key explicitly; there are no defaults.
const fullPackageCapabilities: Capabilities<PackageManagerCapability> = {
    'packages.list': async () => ({ supported: true }),
    'packages.list.skipCache': async () => ({ supported: true }),
    'packages.refresh': async () => ({ supported: true }),
    'packages.manage': async () => ({ supported: true }),
    'packages.manage.install': async () => ({ supported: true }),
    'packages.manage.uninstall': async () => ({ supported: true }),
    'packages.manage.upgrade': async () => ({ supported: true }),
    'packages.manage.headless': async () => ({ supported: true }),
    'packages.manage.showSkipOption': async () => ({ supported: true }),
    'packages.direct': async () => ({ supported: true }),
    'packages.availableVersions': async () => ({ supported: true }),
};
const fullEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    'environments.list': async () => ({ supported: true }),
    'environments.refresh': async () => ({ supported: true }),
    'environments.resolve': async () => ({ supported: true }),
    'environments.getSelected': async () => ({ supported: true }),
    'environments.setSelected': async () => ({ supported: true }),
    'environments.create': async () => ({ supported: true }),
    'environments.create.quick': async () => ({ supported: true }),
    'environments.create.additionalPackages': async () => ({ supported: true }),
    'environments.remove': async () => ({ supported: true }),
    'environments.remove.headless': async () => ({ supported: true }),
};

const legacyPackageManager: PackageManager = {
    name: 'legacy',
    manage: async () => {},
    refresh: async () => {},
    getPackages: async () => [],
    capabilities: fullPackageCapabilities,
};
const legacyEnvironmentManager: EnvironmentManager = {
    name: 'legacy',
    preferredPackageManagerId: 'example:legacy',
    refresh: async () => {},
    getEnvironments: async () => [],
    get: async () => undefined,
    set: async () => {},
    resolve: async () => undefined,
    capabilities: fullEnvironmentCapabilities,
};

// Capability authoring and raw-provider resolution.
const advertised: Capabilities<PackageManagerCapability> = {
    ...fullPackageCapabilities,
    'packages.manage.install': (context: CapabilityContext) =>
        resolvePackageManagerCapability(legacyPackageManager, 'packages.manage', context),
    'packages.direct': async (_context) => ({ supported: false, reason: 'Unavailable' }),
};
const managerWithCapabilities: PackageManager = { ...legacyPackageManager, capabilities: advertised };
resolvePackageManagerCapability(managerWithCapabilities, 'packages.direct', { environment }) satisfies Promise<Support>;
resolveEnvironmentManagerCapability(legacyEnvironmentManager, 'environments.create', {
    scope: 'global',
}) satisfies Promise<Support>;

// Public queries and support-result narrowing.
api.getPackageManagerCapability(environment, 'packages.list') satisfies Promise<Support>;
api.getEnvironmentManagerCapability('example:legacy', 'environments.list', { scope: 'all' }) satisfies Promise<Support>;
declare const support: Support;
if (!support.supported) {
    support.reason satisfies string;
}

// Invalid capability keys, advertisements, and context must remain compile errors.
// @ts-expect-error Package keys do not belong to the environment capability domain.
'packages.list' satisfies EnvironmentManagerCapability;
// @ts-expect-error Environment keys do not belong to the package capability domain.
'environments.list' satisfies PackageManagerCapability;
// @ts-expect-error Advertisements must be asynchronous functions, not static Support values.
({ 'packages.list': { supported: true } } satisfies Capabilities<PackageManagerCapability>);
// @ts-expect-error Advertisements cannot introduce arbitrary keys.
({ 'packages.unknown': async () => ({ supported: true }) } satisfies Capabilities<PackageManagerCapability>);
// @ts-expect-error Operation options are not capability query context.
({ createOptions: { quickCreate: true } } satisfies CapabilityContext);
// @ts-expect-error Named creation is deferred rather than an enabled capability.
resolveEnvironmentManagerCapability(legacyEnvironmentManager, 'environments.create.named');

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
({ 'packages.list': async () => ({ supported: true }) } satisfies Capabilities<PackageManagerCapability>);
