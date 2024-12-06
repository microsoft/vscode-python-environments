import * as path from 'path';
import { CancellationError, CancellationToken, LogOutputChannel, QuickPickItem, Uri, window } from 'vscode';
import {
    EnvironmentManager,
    Package,
    PackageInstallOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../api';
import * as ch from 'child_process';
import { ENVS_EXTENSION_ID, EXTENSION_ROOT_DIR } from '../../common/constants';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { createDeferred } from '../../common/utils/deferred';
import { showErrorMessage } from '../../common/errors/utils';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { shortVersion, sortEnvironments } from '../common/utils';

export const SYSTEM_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:system:WORKSPACE_SELECTED`;
export const SYSTEM_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:system:GLOBAL_SELECTED`;

export async function clearSystemEnvCache(): Promise<void> {
    const keys = [SYSTEM_WORKSPACE_KEY, SYSTEM_GLOBAL_KEY];
    const state = await getWorkspacePersistentState();
    await state.clear(keys);
}

export async function getSystemEnvForWorkspace(fsPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(SYSTEM_WORKSPACE_KEY);
    if (data) {
        try {
            return data[fsPath];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setSystemEnvForWorkspace(fsPath: string, envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(SYSTEM_WORKSPACE_KEY)) ?? {};
    if (envPath) {
        data[fsPath] = envPath;
    } else {
        delete data[fsPath];
    }
    await state.set(SYSTEM_WORKSPACE_KEY, data);
}

export async function getSystemEnvForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return await state.get(SYSTEM_GLOBAL_KEY);
}

export async function setSystemEnvForGlobal(envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(SYSTEM_GLOBAL_KEY, envPath);
}

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
        placeHolder: uninstall ? 'Select packages to uninstall' : 'Select packages to install',
        canPickMany: true,
        ignoreFocusOut: true,
    });

    if (Array.isArray(result)) {
        return result.map((e) => e.label);
    }
    return [];
}

const available = createDeferred<boolean>();
export async function isUvInstalled(log?: LogOutputChannel): Promise<boolean> {
    if (available.completed) {
        return available.promise;
    }

    const proc = ch.spawn('uv', ['--version']);
    proc.on('error', () => {
        available.resolve(false);
    });
    proc.stdout.on('data', (d) => log?.info(d.toString()));
    proc.on('exit', (code) => {
        available.resolve(code === 0);
    });
    return available.promise;
}

export async function runUV(
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
): Promise<string> {
    log?.info(`Running: uv ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const proc = ch.spawn('uv', args, { cwd: cwd });
        token?.onCancellationRequested(() => {
            proc.kill();
            reject(new CancellationError());
        });

        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(s);
        });
        proc.stderr?.on('data', (data) => {
            log?.append(data.toString('utf-8'));
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run python ${args.join(' ')}`));
            }
        });
    });
}

export async function runPython(
    python: string,
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
): Promise<string> {
    log?.info(`Running: ${python} ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const proc = ch.spawn(python, args, { cwd: cwd });
        token?.onCancellationRequested(() => {
            proc.kill();
            reject(new CancellationError());
        });
        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(`python: ${s}`);
        });
        proc.stderr?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(`python: ${s}`);
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run python ${args.join(' ')}`));
            }
        });
    });
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
            iconPath: {
                light: Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', 'light_mode_icon.svg')),
                dark: Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', 'dark_mode_icon.svg')),
            },
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
        showErrorMessage(`No executable found for python: ${environment.environmentPath.fsPath}`, manager.log);
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
        showErrorMessage('Error refreshing packages', manager.log);
        return [];
    }

    const collection: Package[] = [];

    const lines = data.split('\n').splice(2);
    for (let line of lines) {
        const parts = line.split(' ').filter((e) => e);
        if (parts.length > 1) {
            const name = parts[0].trim();
            const version = parts[1].trim();
            const pkg = api.createPackageItem(
                {
                    name,
                    version,
                    displayName: name,
                    description: version,
                },
                environment,
                manager,
            );
            collection.push(pkg);
        }
    }
    return collection;
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
