import { CancellationToken, LogOutputChannel, ProgressLocation, QuickPickItem, Uri, window } from 'vscode';
import {
    EnvironmentManager,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../api';
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { getExtension } from '../../common/extension.apis';
import { Common, PixiStrings, SysManagerStrings } from '../../common/localize';
import { traceInfo, traceVerbose } from '../../common/logging';
import { getGlobalPersistentState } from '../../common/persistentState';
import { showInformationMessage, withProgress } from '../../common/window.apis';
import { installExtension } from '../../common/workbenchCommands';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { shortVersion, sortEnvironments } from '../common/utils';
import { runPython, runUV, shouldUseUv } from './helpers';
import { parsePipList, PipPackage } from './pipListUtils';

const PIXI_EXTENSION_ID = 'renan-r-santos.pixi-code';
const PIXI_RECOMMEND_DONT_ASK_KEY = 'pixi-extension-recommend-dont-ask';
let pixiRecommendationShown = false;

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
            description: undefined,
            tooltip: env.executable,
            environmentPath: Uri.file(env.executable),
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

async function recommendPixiExtension(): Promise<void> {
    if (pixiRecommendationShown) {
        return;
    }
    pixiRecommendationShown = true;

    if (getExtension(PIXI_EXTENSION_ID)) {
        return;
    }

    const state = await getGlobalPersistentState();
    const dontAsk = await state.get<boolean>(PIXI_RECOMMEND_DONT_ASK_KEY);
    if (dontAsk) {
        traceInfo('Skipping Pixi extension recommendation: user selected "Don\'t ask again"');
        return;
    }

    const result = await showInformationMessage(
        PixiStrings.pixiExtensionRecommendation,
        PixiStrings.install,
        Common.dontAskAgain,
    );

    if (result === PixiStrings.install) {
        traceInfo(`Installing extension: ${PIXI_EXTENSION_ID}`);
        await installExtension(PIXI_EXTENSION_ID);
    } else if (result === Common.dontAskAgain) {
        await state.set(PIXI_RECOMMEND_DONT_ASK_KEY, true);
        traceInfo('User selected "Don\'t ask again" for Pixi extension recommendation');
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
    const allNativeEnvs = data.filter((e) => isNativeEnvInfo(e)).map((e) => e as NativeEnvInfo);

    const hasPixiEnvs = allNativeEnvs.some((e) => e.kind === NativePythonEnvironmentKind.pixi);
    if (hasPixiEnvs) {
        recommendPixiExtension().catch((e) => log.error('Error recommending Pixi extension', e));
    }

    const envs = allNativeEnvs.filter(
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

const PIP_LIST_TIMEOUT_MS = 30_000;

async function refreshPipPackagesRaw(environment: PythonEnvironment, log?: LogOutputChannel): Promise<string> {
    // Use environmentPath directly for consistency with UV environment tracking
    const useUv = await shouldUseUv(log, environment.environmentPath.fsPath);
    if (useUv) {
        return await runUV(
            ['pip', 'list', '--python', environment.execInfo.run.executable],
            undefined,
            log,
            undefined,
            PIP_LIST_TIMEOUT_MS,
        );
    }
    try {
        return await runPython(
            environment.execInfo.run.executable,
            ['-m', 'pip', 'list'],
            undefined,
            log,
            undefined,
            PIP_LIST_TIMEOUT_MS,
        );
    } catch (ex) {
        log?.error('Error running pip list', ex);
        log?.info(
            'Package list retrieval attempted using pip, action can be done with uv if installed and setting `alwaysUseUv` is enabled.',
        );
        throw ex;
    }
}

export async function refreshPipPackages(
    environment: PythonEnvironment,
    log?: LogOutputChannel,
    options?: { showProgress: boolean },
): Promise<PipPackage[] | undefined> {
    let data: string;
    try {
        if (options?.showProgress) {
            data = await withProgress(
                {
                    location: ProgressLocation.Notification,
                },
                async () => {
                    return await refreshPipPackagesRaw(environment, log);
                },
            );
        } else {
            data = await refreshPipPackagesRaw(environment, log);
        }

        return parsePipList(data);
    } catch (e) {
        log?.error('Error refreshing packages', e);
        showErrorMessageWithLogs(SysManagerStrings.packageRefreshError, log);
        return undefined;
    }
}

export async function refreshPackages(
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    manager: PackageManager,
): Promise<Package[]> {
    const data = await refreshPipPackages(environment, manager.log);
    return (data ?? []).map((pkg) => api.createPackageItem(pkg, environment, manager));
}

export async function managePackages(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
    api: PythonEnvironmentApi,
    manager: PackageManager,
    token?: CancellationToken,
): Promise<Package[]> {
    if (environment.version.startsWith('2.')) {
        throw new Error('Python 2.* is not supported (deprecated)');
    }

    // Use environmentPath directly for consistency with UV environment tracking
    const useUv = await shouldUseUv(manager.log, environment.environmentPath.fsPath);
    const uninstallArgs = ['pip', 'uninstall'];
    if (options.uninstall && options.uninstall.length > 0) {
        if (useUv) {
            await runUV(
                [...uninstallArgs, '--python', environment.execInfo.run.executable, ...options.uninstall],
                undefined,
                manager.log,
                token,
            );
        } else {
            uninstallArgs.push('--yes');
            await runPython(
                environment.execInfo.run.executable,
                ['-m', ...uninstallArgs, ...options.uninstall],
                undefined,
                manager.log,
                token,
            );
        }
    }

    const installArgs = ['pip', 'install'];
    if (options.upgrade) {
        installArgs.push('--upgrade');
    }
    if (options.install && options.install.length > 0) {
        const processedInstallArgs = processEditableInstallArgs(options.install);

        if (useUv) {
            await runUV(
                [...installArgs, '--python', environment.execInfo.run.executable, ...processedInstallArgs],
                undefined,
                manager.log,
                token,
            );
        } else {
            await runPython(
                environment.execInfo.run.executable,
                ['-m', ...installArgs, ...processedInstallArgs],
                undefined,
                manager.log,
                token,
            );
        }
    }

    return await refreshPackages(environment, api, manager);
}

/**
 * Process pip install arguments to correctly handle editable installs with extras
 * This function will combine consecutive -e arguments that represent the same package with extras
 */
export function processEditableInstallArgs(args: string[]): string[] {
    const processedArgs: string[] = [];
    let i = 0;

    while (i < args.length) {
        if (args[i] === '-e') {
            const packagePath = args[i + 1];
            if (!packagePath) {
                processedArgs.push(args[i]);
                i++;
                continue;
            }

            if (i + 2 < args.length && args[i + 2] === '-e' && i + 3 < args.length) {
                const nextArg = args[i + 3];

                if (nextArg.startsWith('.[') && nextArg.includes(']')) {
                    const combinedPath = packagePath + nextArg.substring(1);
                    processedArgs.push('-e', combinedPath);
                    i += 4;
                    continue;
                }
            }

            processedArgs.push(args[i], packagePath);
            i += 2;
        } else {
            processedArgs.push(args[i]);
            i++;
        }
    }

    return processedArgs;
}

export async function resolveSystemPythonEnvironmentPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const resolved = await nativeFinder.resolve(fsPath);

        // This is supposed to handle a python interpreter as long as we know some basic things about it
        if (resolved.executable && resolved.version && resolved.prefix) {
            const envInfo = getPythonInfo(resolved);
            return api.createPythonEnvironmentItem(envInfo, manager);
        }
    } catch (ex) {
        traceVerbose(`Failed to resolve env "${fsPath}": ${ex}`);
    }
    return undefined;
}
