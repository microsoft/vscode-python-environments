import type {
    PackageManager,
    Pep440Version,
    PythonEnvironment,
    PythonPackageGetterApi,
} from '@vscode/python-environments';
import {
    isPackageVersionLookupNotSupportedError,
    PackageVersionLookupNotSupportedError,
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
void lookupErrorIsError;
void lookupErrorCodeIsExact;
void guardNarrows;
