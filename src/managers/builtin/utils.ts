import * as fs from 'fs-extra';
import * as path from 'path';
import { LogOutputChannel, QuickPickItem, Uri, window } from 'vscode';
import { EnvironmentManager, Package, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../api';
import { getExtension } from '../../common/extension.apis';
import { Common, PixiStrings, SysManagerStrings } from '../../common/localize';
import { traceInfo, traceVerbose } from '../../common/logging';
import { getGlobalPersistentState } from '../../common/persistentState';
import { showInformationMessage } from '../../common/window.apis';
import { openExtension } from '../../common/workbenchCommands';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getLatest, shortenVersionString, sortEnvironments } from '../common/utils';

const PIXI_EXTENSION_ID = 'renan-r-santos.pixi-code';
const PIXI_RECOMMEND_DONT_ASK_KEY = 'pixi-extension-recommend-dont-ask';
let pixiRecommendationShown = false;

// Global environments created for uv-managed Python installations.
const uvManagedPythons = new WeakSet<PythonEnvironment>();

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

/** Create the ordinary System-manager presentation and execution contract from resolved runtime metadata. */
export function getSystemPythonInfo(env: NativeEnvInfo, uvManaged: boolean = false): PythonEnvironmentInfo {
    if (env.executable && env.version && env.prefix) {
        const kindName = uvManaged ? 'uv' : getKindName(env.kind);
        const sv = shortenVersionString(env.version);
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
        traceInfo(`Opening extension page: ${PIXI_EXTENSION_ID}`);
        await openExtension(PIXI_EXTENSION_ID);
    } else if (result === Common.dontAskAgain) {
        await state.set(PIXI_RECOMMEND_DONT_ASK_KEY, true);
        traceInfo('User selected "Don\'t ask again" for Pixi extension recommendation');
    }
}

/**
 * Returns true when PET reports a Python installation managed by uv (`uv python install`).
 *
 * PET reports both uv-created virtual environments and uv-managed Python installations with the
 * `Uv` kind. Only virtual environments have a `pyvenv.cfg` in their prefix, so its absence
 * identifies a base interpreter that belongs with the global Python installations.
 *
 * @param env Environment information reported by PET.
 * @returns `true` for a uv-managed base interpreter, otherwise `false`.
 */
export async function isUvManagedPythonInstall(env: NativeEnvInfo): Promise<boolean> {
    if (env.kind !== NativePythonEnvironmentKind.venvUv || !env.prefix) {
        return false;
    }
    return !(await fs.pathExists(path.join(env.prefix, 'pyvenv.cfg')));
}

/**
 * Returns the global Python to use by default: the newest one, preferring installations that are not
 * managed by uv. uv marks its installations EXTERNALLY-MANAGED (PEP 668), so installing packages into
 * them fails; they are used by default only when no other Python is available.
 *
 * @param globals Global Python environments.
 * @returns The default global Python, or `undefined` when there is none.
 */
export function getDefaultGlobalPython(globals: PythonEnvironment[]): PythonEnvironment | undefined {
    const preferred = globals.filter((e) => !e.error && !uvManagedPythons.has(e));
    return getLatest(preferred.length > 0 ? preferred : globals);
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

    const envs: { env: NativeEnvInfo; uvManaged: boolean }[] = [];
    for (const e of allNativeEnvs) {
        const uvManaged = e.kind === NativePythonEnvironmentKind.venvUv && (await isUvManagedPythonInstall(e));
        if (
            uvManaged ||
            e.kind === undefined ||
            [
                NativePythonEnvironmentKind.globalPaths,
                NativePythonEnvironmentKind.homebrew,
                NativePythonEnvironmentKind.linuxGlobal,
                NativePythonEnvironmentKind.macCommandLineTools,
                NativePythonEnvironmentKind.macPythonOrg,
                NativePythonEnvironmentKind.macXCode,
                NativePythonEnvironmentKind.windowsRegistry,
                NativePythonEnvironmentKind.windowsStore,
                NativePythonEnvironmentKind.winpython,
            ].includes(e.kind)
        ) {
            envs.push({ env: e, uvManaged });
        }
    }
    envs.forEach(({ env, uvManaged }) => {
        try {
            const envInfo = getSystemPythonInfo(env, uvManaged);
            const python = api.createPythonEnvironmentItem(envInfo, manager);
            if (uvManaged) {
                uvManagedPythons.add(python);
            }
            collection.push(python);
        } catch (e) {
            log.error((e as Error).message);
        }
    });
    return sortEnvironments(collection);
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
            const uvManaged = await isUvManagedPythonInstall(resolved);
            const python = api.createPythonEnvironmentItem(getSystemPythonInfo(resolved, uvManaged), manager);
            if (uvManaged) {
                uvManagedPythons.add(python);
            }
            return python;
        }
    } catch (ex) {
        traceVerbose(`Failed to resolve env "${fsPath}": ${ex}`);
    }
    return undefined;
}
