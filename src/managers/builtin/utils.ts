import { CancellationToken, l10n, LogOutputChannel, QuickPickItem, ThemeIcon, Uri, window } from 'vscode';
import {
    EnvironmentManager,
    Package,
    PackageInstallOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../api';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { showErrorMessage } from '../../common/errors/utils';
import { shortVersion, sortEnvironments } from '../common/utils';
import { SysManagerStrings } from '../../common/localize';
import { isUvInstalled, runUV, runPython } from './helpers';
import { parsePipList } from './pipListUtils';

function asPackageQuickPickItem(name: string, version?: string): QuickPickItem {
    return {
        label: name,
        description: version,
    };
}

export async function pickPackages(uninstall: boolean, packages: string[] | Package[]): Promise<string[]> {
    const items = packages.map((pkg) => {
        if (typeof pkg === 'string') {
            return asPackageQuickPickItem(pkg);
        }
        return asPackageQuickPickItem(pkg.name, pkg.version);
    });

    const result = await window.showQuickPick(items, {
        placeHolder: uninstall ? SysManagerStrings.selectUninstall : SysManagerStrings.selectInstall,
        canPickMany: true,
        ignoreFocusOut: true,
    });

    if (Array.isArray(result)) {
        return result.map((e) => e.label);
    }
    return [];
}

function getKindName(kind: NativePythonEnvironmentKind | undefined): string | undefined {
    switch (kind) {
        case NativePythonEnvironmentKind.homebrew:
            return 'homebrew';

        case NativePythonEnvironmentKind.macXCode:
            return 'xcode';

        case NativePythonEnvironmentKind.windowsStore:
            return 'store';

        case NativePythonEnvironmentKind.macCommandLineTools:
        case NativePythonEnvironmentKind.macPythonOrg:
        case NativePythonEnvironmentKind.globalPaths:
        case NativePythonEnvironmentKind.linuxGlobal:
        case NativePythonEnvironmentKind.windowsRegistry:
        default:
            return undefined;
    }
}

function getPythonInfo(env: NativeEnvInfo): PythonEnvironmentInfo {
    if (env.executable && env.version && env.prefix) {
        const kindName = getKindName(env.kind);
        const sv = shortVersion(env.version);
        const name = kindName ? `Python ${sv} (${kindName})` : `Python ${sv}`;
        const displayName = kindName ? `Python ${sv} (${kindName})` : `Python ${sv}`;
        const shortDisplayName = kindName ? `${sv} (${kindName})` : `${sv}`;
        return {
            name: env.name ?? name,
            displayName: env.displayName ?? displayName,
            shortDisplayName: shortDisplayName,
            displayPath: env.executable,
            version: env.version,
            description: env.executable,
            environmentPath: Uri.file(env.executable),
            iconPath: new ThemeIcon('globe'),
            sysPrefix: env.prefix,
            execInfo: {
                run: {
                    executable: env.executable,
                    args: [],
                },
            },
        };
    } else {
        throw new Error(`Invalid python info: ${JSON.stringify(env)}`);
    }
}

export async function refreshPythons(
    hardRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    uris?: Uri[],
): Promise<PythonEnvironment[]> {
    const collection: PythonEnvironment[] = [];
    const data = await nativeFinder.refresh(hardRefresh, uris);
    const envs = data
        .filter((e) => isNativeEnvInfo(e))
        .map((e) => e as NativeEnvInfo)
        .filter(
            (e) =>
                e.kind === undefined ||
                (e.kind &&
                    [
                        NativePythonEnvironmentKind.globalPaths,
                        NativePythonEnvironmentKind.homebrew,
                        NativePythonEnvironmentKind.linuxGlobal,
                        NativePythonEnvironmentKind.macCommandLineTools,
                        NativePythonEnvironmentKind.macPythonOrg,
                        NativePythonEnvironmentKind.macXCode,
                        NativePythonEnvironmentKind.windowsRegistry,
                        NativePythonEnvironmentKind.windowsStore,
                    ].includes(e.kind)),
        );
    envs.forEach((env) => {
        try {
            const envInfo = getPythonInfo(env);
            const python = api.createPythonEnvironmentItem(envInfo, manager);
            collection.push(python);
        } catch (e) {
            log.error((e as Error).message);
        }
    });
    return sortEnvironments(collection);
}

export async function refreshPackages(
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    manager: PackageManager,
): Promise<Package[]> {
    if (!environment.execInfo) {
        manager.log?.error(`No executable found for python: ${environment.environmentPath.fsPath}`);
        showErrorMessage(
            l10n.t('No executable found for python: {0}', environment.environmentPath.fsPath),
            manager.log,
        );
        return [];
    }

    let data: string;
    try {
        const useUv = await isUvInstalled();
        if (useUv) {
            data = await runUV(
                ['pip', 'list', '--python', environment.execInfo.run.executable],
                undefined,
                manager.log,
            );
        } else {
            data = await runPython(environment.execInfo.run.executable, ['-m', 'pip', 'list'], undefined, manager.log);
        }
    } catch (e) {
        manager.log?.error('Error refreshing packages', e);
        showErrorMessage(SysManagerStrings.packageRefreshError, manager.log);
        return [];
    }

    return parsePipList(data).map((pkg) => api.createPackageItem(pkg, environment, manager));
}

export async function installPackages(
    environment: PythonEnvironment,
    packages: string[],
    options: PackageInstallOptions,
    api: PythonEnvironmentApi,
    manager: PackageManager,
    token?: CancellationToken,
): Promise<Package[]> {
    if (environment.version.startsWith('2.')) {
        throw new Error('Python 2.* is not supported (deprecated)');
    }

    if (environment.execInfo) {
        if (packages.length === 0) {
            throw new Error('No packages selected to install');
        }

        const useUv = await isUvInstalled();

        const installArgs = ['pip', 'install'];
        if (options.upgrade) {
            installArgs.push('--upgrade');
        }
        if (useUv) {
            await runUV(
                [...installArgs, '--python', environment.execInfo.run.executable, ...packages],
                undefined,
                manager.log,
                token,
            );
        } else {
            await runPython(
                environment.execInfo.run.executable,
                ['-m', ...installArgs, ...packages],
                undefined,
                manager.log,
                token,
            );
        }

        return refreshPackages(environment, api, manager);
    }
    throw new Error(`No executable found for python: ${environment.environmentPath.fsPath}`);
}

export async function uninstallPackages(
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    manager: PackageManager,
    packages: string[] | Package[],
    token?: CancellationToken,
): Promise<Package[]> {
    if (environment.version.startsWith('2.')) {
        throw new Error('Python 2.* is not supported (deprecated)');
    }

    if (environment.execInfo) {
        const remove = [];
        for (let pkg of packages) {
            if (typeof pkg === 'string') {
                remove.push(pkg);
            } else {
                remove.push(pkg.name);
            }
        }
        if (remove.length === 0) {
            const installed = await manager.getPackages(environment);
            if (installed) {
                const packages = await pickPackages(true, installed);
                if (packages.length === 0) {
                    throw new Error('No packages selected to uninstall');
                }
            }
        }

        const useUv = await isUvInstalled();
        if (useUv) {
            await runUV(
                ['pip', 'uninstall', '--python', environment.execInfo.run.executable, ...remove],
                undefined,
                manager.log,
                token,
            );
        } else {
            await runPython(
                environment.execInfo.run.executable,
                ['-m', 'pip', 'uninstall', '-y', ...remove],
                undefined,
                manager.log,
                token,
            );
        }
        return refreshPackages(environment, api, manager);
    }
    throw new Error(`No executable found for python: ${environment.environmentPath.fsPath}`);
}

export async function resolveSystemPythonEnvironmentPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    const resolved = await nativeFinder.resolve(fsPath);

    // This is supposed to handle a python interpreter as long as we know some basic things about it
    if (resolved.executable && resolved.version && resolved.prefix) {
        const envInfo = getPythonInfo(resolved);
        return api.createPythonEnvironmentItem(envInfo, manager);
    }
}
