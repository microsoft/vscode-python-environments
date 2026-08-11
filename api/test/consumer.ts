import type {
    PackageManager,
    Pep440Version,
    PythonEnvironment,
    PythonPackageGetterApi,
} from '@vscode/python-environments';

const getAvailableVersions: PythonPackageGetterApi['getPackageAvailableVersions'] = async (
    _environment: PythonEnvironment,
    _packageName: string,
): Promise<Pep440Version[] | undefined> => [];

const refreshPackages: PackageManager['refresh'] = async (_environment: PythonEnvironment): Promise<void> => {};

void getAvailableVersions;
void refreshPackages;
