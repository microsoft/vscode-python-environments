import type {
    Capabilities,
    CapabilityContext,
    DefaultCapabilityCheck,
    EnvironmentManagerCapability,
    EnvironmentManager,
    PackageManagerCapability,
    PackageManager,
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
    defaultEnvironmentCapabilities,
    defaultPackageCapabilities,
    resolveEnvironmentManagerCapability,
    resolvePackageManagerCapability,
} from '@vscode/python-environments';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

type AvailableVersionsReturn = ReturnType<PythonPackageGetterApi['getPackageAvailableVersions']>;
type RefreshReturn = ReturnType<PackageManager['refresh']>;

const availableVersionsReturnIsExact: Equal<AvailableVersionsReturn, Promise<Pep440Version[] | undefined>> = true;
const refreshReturnIsExact: Equal<RefreshReturn, Promise<void>> = true;

declare const api: PythonPackageGetterApi;
declare const environment: PythonEnvironment;
const legacyAvailableVersions: Promise<Pep440Version[] | undefined> = api.getPackageAvailableVersions(
    environment,
    'example',
);
const explicitLegacyAvailableVersions: Promise<Pep440Version[] | undefined> = api.getPackageAvailableVersions(
    environment,
    'example',
    { errorMode: 'legacy' },
);
const throwingAvailableVersions: Promise<Pep440Version[]> = api.getPackageAvailableVersions(environment, 'example', {
    errorMode: 'throw',
});
const runtimeApi: Promise<PythonEnvironmentApi> = PythonEnvironments.api();

// The unsupported-capability error is part of the public contract: it is constructible, extends
// Error, and exposes a stable string-literal `code` discriminator.
const lookupError = new PackageVersionLookupNotSupportedError('unsupported');
const lookupErrorIsError: Error = lookupError;
const lookupErrorCodeIsExact: Equal<typeof lookupError.code, 'PackageVersionLookupNotSupported'> = true;

// The type guard narrows unknown values via the stable discriminator (bundle-boundary safe).
declare const maybeError: unknown;
const guardNarrows: boolean = isPackageVersionLookupNotSupportedError(maybeError)
    ? maybeError.code === 'PackageVersionLookupNotSupported'
    : false;

void availableVersionsReturnIsExact;
void refreshReturnIsExact;
void legacyAvailableVersions;
void explicitLegacyAvailableVersions;
void throwingAvailableVersions;
void runtimeApi;
void lookupErrorIsError;
void lookupErrorCodeIsExact;
void guardNarrows;

// Legacy providers remain structurally assignable without maps or inheritance.
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
const advertised: Capabilities<PackageManagerCapability> = {
    'packages.manage.install': (context: CapabilityContext) =>
        resolvePackageManagerCapability(legacyPackageManager, 'packages.manage', context),
    'packages.direct': async (_context) => ({ supported: false, reason: 'Unavailable' }),
};
const managerWithCapabilities: PackageManager = { ...legacyPackageManager, capabilities: advertised };
const packageSupport: Promise<Support> =
    resolvePackageManagerCapability(managerWithCapabilities, 'packages.direct', { environment });
const environmentSupport: Promise<Support> =
    resolveEnvironmentManagerCapability(legacyEnvironmentManager, 'environments.create', { scope: 'global' });
const packageDefault: Promise<Support> = defaultPackageCapabilities['packages.list'](legacyPackageManager, {});
const environmentDefault: Promise<Support> =
    defaultEnvironmentCapabilities['environments.list'](legacyEnvironmentManager, {});
declare const fullApi: PythonEnvironmentApi;
const routedPackageSupport: Promise<Support> = fullApi.getPackageManagerCapability(environment, 'packages.list');
const routedEnvironmentSupport: Promise<Support> =
    fullApi.getEnvironmentManagerCapability('example:legacy', 'environments.list', { scope: 'all' });
declare const support: Support;
if (!support.supported) {
    const unsupportedReason: string = support.reason;
    void unsupportedReason;
}

// @ts-expect-error Package keys do not belong to the environment capability domain.
const invalidEnvironmentKey: EnvironmentManagerCapability = 'packages.list';
// @ts-expect-error Environment keys do not belong to the package capability domain.
const invalidPackageKey: PackageManagerCapability = 'environments.list';
// @ts-expect-error Advertisements must be asynchronous functions, not static Support values.
const invalidMap: Capabilities<PackageManagerCapability> = { 'packages.list': { supported: true } };
// @ts-expect-error Operation options are not capability query context.
const invalidContext: CapabilityContext = { createOptions: { quickCreate: true } };
// @ts-expect-error Named creation is deferred rather than an enabled capability.
resolveEnvironmentManagerCapability(legacyEnvironmentManager, 'environments.create.named');

declare const arbitraryKey: string;
// @ts-expect-error A general string is not a declared environment capability.
resolveEnvironmentManagerCapability(legacyEnvironmentManager, arbitraryKey);
// @ts-expect-error A general string is not a declared package capability.
resolvePackageManagerCapability(legacyPackageManager, arbitraryKey);
// @ts-expect-error Public environment queries require a catalog key.
fullApi.getEnvironmentManagerCapability('example:legacy', arbitraryKey);
// @ts-expect-error Public package queries require a catalog key.
fullApi.getPackageManagerCapability(environment, arbitraryKey);
// @ts-expect-error Default dictionaries have no arbitrary string index signature.
defaultPackageCapabilities[arbitraryKey];
// @ts-expect-error Default dictionaries have no arbitrary string index signature.
defaultEnvironmentCapabilities[arbitraryKey];
// @ts-expect-error Advertisements cannot introduce arbitrary keys.
const unknownCapabilityMap: Capabilities<PackageManagerCapability> = { 'packages.unknown': async () => ({ supported: true }) };

const environmentDefaultsAreComplete: Equal<keyof typeof defaultEnvironmentCapabilities, EnvironmentManagerCapability> = true;
const packageDefaultsAreComplete: Equal<keyof typeof defaultPackageCapabilities, PackageManagerCapability> = true;
const environmentDefaultSignatureIsExact: Equal<
    (typeof defaultEnvironmentCapabilities)['environments.create.quick'],
    DefaultCapabilityCheck<EnvironmentManager>
> = true;
const packageDefaultSignatureIsExact: Equal<
    (typeof defaultPackageCapabilities)['packages.list.skipCache'],
    DefaultCapabilityCheck<PackageManager>
> = true;

void unknownCapabilityMap;
void environmentDefaultsAreComplete;
void packageDefaultsAreComplete;
void environmentDefaultSignatureIsExact;
void packageDefaultSignatureIsExact;
void packageSupport;
void environmentSupport;
void packageDefault;
void environmentDefault;
void routedPackageSupport;
void routedEnvironmentSupport;
void invalidEnvironmentKey;
void invalidPackageKey;
void invalidMap;
void invalidContext;
