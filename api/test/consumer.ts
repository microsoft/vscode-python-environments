import type {
    PackageManager,
    Pep440Version,
    PythonEnvironment,
    PythonPackageGetterApi,
} from '@vscode/python-environments';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

type AvailableVersionsReturn = ReturnType<PythonPackageGetterApi['getPackageAvailableVersions']>;
type RefreshReturn = ReturnType<PackageManager['refresh']>;

const availableVersionsReturnIsExact: Equal<AvailableVersionsReturn, Promise<Pep440Version[] | undefined>> = true;
const refreshReturnIsExact: Equal<RefreshReturn, Promise<void>> = true;

declare const api: PythonPackageGetterApi;
declare const environment: PythonEnvironment;
const availableVersions: Promise<Pep440Version[] | undefined> = api.getPackageAvailableVersions(environment, 'example');

void availableVersionsReturnIsExact;
void refreshReturnIsExact;
void availableVersions;
