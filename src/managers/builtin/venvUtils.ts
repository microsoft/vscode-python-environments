import * as fsapi from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { l10n, LogOutputChannel, ProgressLocation, QuickPickItem, QuickPickItemKind, ThemeIcon, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../api';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { Common, VenvManagerStrings } from '../../common/localize';
import { traceInfo } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
// Using direct access to environments rather than pickEnvironmentFrom
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import {
    showErrorMessage,
    showOpenDialog,
    showQuickPick,
    showWarningMessage,
    withProgress,
} from '../../common/window.apis';
import { getConfiguration } from '../../common/workspace.apis';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getShellActivationCommands, shortVersion, sortEnvironments } from '../common/utils';
import { isUvInstalled, runPython, runUV } from './helpers';
import { getProjectInstallable, PipPackages } from './pipUtils';
import { resolveSystemPythonEnvironmentPath } from './utils';
import { createStepBasedVenvFlow } from './venvStepBasedFlow';

export const VENV_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:venv:WORKSPACE_SELECTED`;
export const VENV_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:venv:GLOBAL_SELECTED`;

/**
 * Result of environment creation operation.
 */
export interface CreateEnvironmentResult {
    /**
     * The created environment, if successful.
     */
    environment?: PythonEnvironment;

    /*
     * Exists if error occurred during environment creation and includes error explanation.
     */
    envCreationErr?: string;

    /*
     * Exists if error occurred while installing packages and includes error description.
     */
    pkgInstallationErr?: string;
}

export async function clearVenvCache(): Promise<void> {
    const keys = [VENV_WORKSPACE_KEY, VENV_GLOBAL_KEY];
    const state = await getWorkspacePersistentState();
    await state.clear(keys);
}

export async function getVenvForWorkspace(fsPath: string): Promise<string | undefined> {
    if (process.env.VIRTUAL_ENV) {
        return process.env.VIRTUAL_ENV;
    }

    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(VENV_WORKSPACE_KEY);
    if (data) {
        try {
            const envPath = data[fsPath];
            if (await fsapi.pathExists(envPath)) {
                return envPath;
            }
            setVenvForWorkspace(fsPath, undefined);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setVenvForWorkspace(fsPath: string, envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(VENV_WORKSPACE_KEY)) ?? {};
    if (envPath) {
        data[fsPath] = envPath;
    } else {
        delete data[fsPath];
    }
    await state.set(VENV_WORKSPACE_KEY, data);
}

export async function setVenvForWorkspaces(fsPaths: string[], envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(VENV_WORKSPACE_KEY)) ?? {};
    fsPaths.forEach((s) => {
        if (envPath) {
            data[s] = envPath;
        } else {
            delete data[s];
        }
    });
    await state.set(VENV_WORKSPACE_KEY, data);
}

export async function getVenvForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const envPath: string | undefined = await state.get(VENV_GLOBAL_KEY);
    if (envPath && (await fsapi.pathExists(envPath))) {
        return envPath;
    }
    return undefined;
}

export async function setVenvForGlobal(envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(VENV_GLOBAL_KEY, envPath);
}

function getName(binPath: string): string {
    const dir1 = path.dirname(binPath);
    if (dir1.endsWith('bin') || dir1.endsWith('Scripts') || dir1.endsWith('scripts')) {
        return path.basename(path.dirname(dir1));
    }
    return path.basename(dir1);
}

async function getPythonInfo(env: NativeEnvInfo): Promise<PythonEnvironmentInfo> {
    if (env.executable && env.version && env.prefix) {
        const venvName = env.name ?? getName(env.executable);
        const sv = shortVersion(env.version);
        const name = `${venvName} (${sv})`;

        const binDir = path.dirname(env.executable);

        const { shellActivation, shellDeactivation } = await getShellActivationCommands(binDir);

        return {
            name: name,
            displayName: name,
            shortDisplayName: `${sv} (${venvName})`,
            displayPath: env.executable,
            version: env.version,
            description: undefined,
            tooltip: env.executable,
            environmentPath: Uri.file(env.executable),
            iconPath: new ThemeIcon('python'),
            sysPrefix: env.prefix,
            execInfo: {
                run: {
                    executable: env.executable,
                },
                activatedRun: {
                    executable: env.executable,
                },
                shellActivation,
                shellDeactivation,
            },
        };
    } else {
        throw new Error(`Invalid python info: ${JSON.stringify(env)}`);
    }
}

export async function findVirtualEnvironments(
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
        .filter((e) => e.kind === NativePythonEnvironmentKind.venv);

    for (const e of envs) {
        if (!(e.prefix && e.executable && e.version)) {
            log.warn(`Invalid venv environment: ${JSON.stringify(e)}`);
            continue;
        }

        const env = api.createPythonEnvironmentItem(await getPythonInfo(e), manager);
        collection.push(env);
        log.info(`Found venv environment: ${env.name}`);
    }
    return collection;
}

export async function getDefaultGlobalVenvLocation(): Promise<Uri> {
    const dir = path.join(os.homedir(), '.virtualenvs');
    await fsapi.ensureDir(dir);
    return Uri.file(dir);
}

function getVenvFoldersSetting(): string[] {
    const settings = getConfiguration('python');
    return settings.get<string[]>('venvFolders', []);
}

interface FolderQuickPickItem extends QuickPickItem {
    uri?: Uri;
}
export async function getGlobalVenvLocation(): Promise<Uri | undefined> {
    const items: FolderQuickPickItem[] = [
        {
            label: Common.browse,
            description: VenvManagerStrings.venvGlobalFolder,
        },
    ];

    const venvPaths = getVenvFoldersSetting();
    if (venvPaths.length > 0) {
        items.push(
            {
                label: VenvManagerStrings.venvGlobalFoldersSetting,
                kind: QuickPickItemKind.Separator,
            },
            ...venvPaths.map((p) => ({
                label: path.basename(p),
                description: path.resolve(p),
                uri: Uri.file(path.resolve(p)),
            })),
        );
    }

    if (process.env.WORKON_HOME) {
        items.push(
            {
                label: 'virtualenvwrapper',
                kind: QuickPickItemKind.Separator,
            },
            {
                label: 'WORKON_HOME (env variable)',
                description: process.env.WORKON_HOME,
                uri: Uri.file(process.env.WORKON_HOME),
            },
        );
    }

    const selected = await showQuickPick(items, {
        placeHolder: VenvManagerStrings.venvGlobalFolder,
        ignoreFocusOut: true,
    });

    if (selected) {
        if (selected.label === Common.browse) {
            const result = await showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: Common.selectFolder,
            });
            if (result && result.length > 0) {
                return result[0];
            }
        } else if (selected.uri) {
            return selected.uri;
        }
    }
    return undefined;
}

export async function createWithProgress(
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    basePython: PythonEnvironment,
    venvRoot: Uri,
    envPath: string,
    packages?: PipPackages,
): Promise<CreateEnvironmentResult | undefined> {
    const pythonPath =
        os.platform() === 'win32' ? path.join(envPath, 'Scripts', 'python.exe') : path.join(envPath, 'bin', 'python');

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: l10n.t(
                'Creating virtual environment named {0} using python version {1}.',
                path.basename(envPath),
                basePython.version,
            ),
        },
        async () => {
            const result: CreateEnvironmentResult = {};
            try {
                const useUv = await isUvInstalled(log);
                // env creation
                if (basePython.execInfo?.run.executable) {
                    if (useUv) {
                        await runUV(
                            ['venv', '--verbose', '--seed', '--python', basePython.execInfo?.run.executable, envPath],
                            venvRoot.fsPath,
                            log,
                        );
                    } else {
                        await runPython(
                            basePython.execInfo.run.executable,
                            ['-m', 'venv', envPath],
                            venvRoot.fsPath,
                            manager.log,
                        );
                    }
                    if (!(await fsapi.pathExists(pythonPath))) {
                        throw new Error('no python executable found in virtual environment');
                    }
                }

                // handle admin of new env
                const resolved = await nativeFinder.resolve(pythonPath);
                const env = api.createPythonEnvironmentItem(await getPythonInfo(resolved), manager);

                // install packages
                if (packages && (packages.install.length > 0 || packages.uninstall.length > 0)) {
                    try {
                        await api.managePackages(env, {
                            upgrade: false,
                            install: packages?.install,
                            uninstall: packages?.uninstall ?? [],
                        });
                    } catch (e) {
                        // error occurred while installing packages
                        result.pkgInstallationErr = e instanceof Error ? e.message : String(e);
                    }
                }
                result.environment = env;
            } catch (e) {
                log.error(`Failed to create virtual environment: ${e}`);
                result.envCreationErr = `Failed to create virtual environment: ${e}`;
            }
            return result;
        },
    );
}

export function ensureGlobalEnv(basePythons: PythonEnvironment[], log: LogOutputChannel): PythonEnvironment[] {
    if (basePythons.length === 0) {
        log.error('No base python found');
        showErrorMessage(VenvManagerStrings.venvErrorNoBasePython);
        throw new Error('No base python found');
    }

    const filtered = basePythons.filter((e) => e.version.startsWith('3.'));
    if (filtered.length === 0) {
        log.error('Did not find any base python 3.*');
        showErrorMessage(VenvManagerStrings.venvErrorNoPython3);
        basePythons.forEach((e, i) => {
            log.error(`${i}: ${e.version} : ${e.environmentPath.fsPath}`);
        });
        throw new Error('Did not find any base python 3.*');
    }

    return sortEnvironments(filtered);
}

export async function quickCreateVenv(
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    baseEnv: PythonEnvironment,
    venvRoot: Uri,
    additionalPackages?: string[],
): Promise<CreateEnvironmentResult | undefined> {
    const project = api.getPythonProject(venvRoot);

    sendTelemetryEvent(EventNames.VENV_CREATION, undefined, { creationType: 'quick' });
    const installables = await getProjectInstallable(api, project ? [project] : undefined);
    const allPackages = [];
    allPackages.push(...(installables?.flatMap((i) => i.args ?? []) ?? []));
    if (additionalPackages) {
        allPackages.push(...additionalPackages);
    }

    // Check if .venv already exists
    let venvPath = path.join(venvRoot.fsPath, '.venv');
    if (await fsapi.pathExists(venvPath)) {
        // increment to create a unique name, e.g. .venv-1
        let i = 1;
        while (await fsapi.pathExists(`${venvPath}-${i}`)) {
            i++;
        }
        venvPath = `${venvPath}-${i}`;
    }

    // createWithProgress handles building CreateEnvironmentResult and adding err msgs
    return await createWithProgress(nativeFinder, api, log, manager, baseEnv, venvRoot, venvPath, {
        install: allPackages,
        uninstall: [],
    });
}

export async function createPythonVenv(
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    basePythons: PythonEnvironment[],
    venvRoot: Uri,
    options: { showQuickAndCustomOptions: boolean; additionalPackages?: string[] },
): Promise<CreateEnvironmentResult | undefined> {
    return createStepBasedVenvFlow(nativeFinder, api, log, manager, basePythons, venvRoot, options);
}

export async function removeVenv(environment: PythonEnvironment, log: LogOutputChannel): Promise<boolean> {
    const pythonPath = os.platform() === 'win32' ? 'python.exe' : 'python';

    const envPath = environment.environmentPath.fsPath.endsWith(pythonPath)
        ? path.dirname(path.dirname(environment.environmentPath.fsPath))
        : environment.environmentPath.fsPath;

    const confirm = await showWarningMessage(
        l10n.t('Are you sure you want to remove {0}?', envPath),
        {
            modal: true,
        },
        { title: Common.yes },
        { title: Common.no, isCloseAffordance: true },
    );
    if (confirm?.title === Common.yes) {
        const result = await withProgress(
            {
                location: ProgressLocation.Notification,
                title: VenvManagerStrings.venvRemoving,
            },
            async () => {
                try {
                    await fsapi.remove(envPath);
                    return true;
                } catch (e) {
                    log.error(`Failed to remove virtual environment: ${e}`);
                    showErrorMessage(VenvManagerStrings.venvRemoveFailed);
                    return false;
                }
            },
        );
        return result;
    }

    traceInfo(`User cancelled removal of virtual environment: ${envPath}`);
    return false;
}

export async function resolveVenvPythonEnvironmentPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    baseManager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    const resolved = await nativeFinder.resolve(fsPath);

    if (resolved.kind === NativePythonEnvironmentKind.venv) {
        const envInfo = await getPythonInfo(resolved);
        return api.createPythonEnvironmentItem(envInfo, manager);
    }

    return resolveSystemPythonEnvironmentPath(fsPath, nativeFinder, api, baseManager);
}
