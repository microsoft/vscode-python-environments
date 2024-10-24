import { LogOutputChannel, ProgressLocation, QuickPickItem, QuickPickItemKind, Uri } from 'vscode';
import {
    EnvironmentManager,
    Installable,
    PythonCommandRunConfiguration,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
    PythonProject,
    ResolveEnvironmentContext,
    TerminalShellType,
} from '../../api';
import * as tomljs from '@iarna/toml';
import * as path from 'path';
import * as os from 'os';
import * as fsapi from 'fs-extra';
import { isUvInstalled, resolveSystemPythonEnvironmentPath, runPython, runUV } from './utils';
import { ENVS_EXTENSION_ID, EXTENSION_ROOT_DIR } from '../../common/constants';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { shortVersion, sortEnvironments } from '../common/utils';
import { findFiles, getConfiguration } from '../../common/workspace.apis';
import { pickEnvironmentFrom } from '../../common/pickers/environments';
import {
    showQuickPick,
    withProgress,
    showWarningMessage,
    showInputBox,
    showOpenDialog,
} from '../../common/window.apis';
import { showErrorMessage } from '../../common/errors/utils';

export const VENV_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:venv:WORKSPACE_SELECTED`;
export const VENV_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:venv:GLOBAL_SELECTED`;

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
            return data[fsPath];
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

export async function getVenvForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return await state.get(VENV_GLOBAL_KEY);
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

function getPythonInfo(env: NativeEnvInfo): PythonEnvironmentInfo {
    if (env.executable && env.version && env.prefix) {
        const venvName = env.name ?? getName(env.executable);
        const sv = shortVersion(env.version);
        const name = `${venvName} (${sv})`;

        const binDir = path.dirname(env.executable);

        const shellActivation: Map<TerminalShellType, PythonCommandRunConfiguration[]> = new Map();
        shellActivation.set(TerminalShellType.bash, [{ executable: 'source', args: [path.join(binDir, 'activate')] }]);
        shellActivation.set(TerminalShellType.powershell, [{ executable: path.join(binDir, 'Activate.ps1') }]);
        shellActivation.set(TerminalShellType.commandPrompt, [{ executable: path.join(binDir, 'activate.bat') }]);
        shellActivation.set(TerminalShellType.unknown, [{ executable: path.join(binDir, 'activate') }]);

        const shellDeactivation = new Map<TerminalShellType, PythonCommandRunConfiguration[]>();
        shellDeactivation.set(TerminalShellType.bash, [{ executable: 'deactivate' }]);
        shellDeactivation.set(TerminalShellType.powershell, [{ executable: 'deactivate' }]);
        shellDeactivation.set(TerminalShellType.commandPrompt, [{ executable: path.join(binDir, 'deactivate.bat') }]);
        shellActivation.set(TerminalShellType.unknown, [{ executable: 'deactivate' }]);

        return {
            name: name,
            displayName: name,
            shortDisplayName: `${sv} (${venvName})`,
            displayPath: env.executable,
            version: env.version,
            description: env.executable,
            environmentPath: Uri.file(env.executable),
            iconPath: Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', 'logo.svg')),
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

    envs.forEach((e) => {
        if (!(e.prefix && e.executable && e.version)) {
            log.warn(`Invalid conda environment: ${JSON.stringify(e)}`);
            return;
        }

        const env = api.createPythonEnvironmentItem(getPythonInfo(e), manager);
        collection.push(env);
        log.info(`Found venv environment: ${env.name}`);
    });
    return collection;
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
            label: 'Browse',
            description: 'Select a folder to create a global virtual environment',
        },
    ];

    const venvPaths = getVenvFoldersSetting();
    if (venvPaths.length > 0) {
        items.push(
            {
                label: 'Venv Folders Setting',
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
                label: 'Virtualenvwrapper',
                kind: QuickPickItemKind.Separator,
            },
            {
                label: 'WORKON_HOME',
                description: process.env.WORKON_HOME,
                uri: Uri.file(process.env.WORKON_HOME),
            },
        );
    }

    const selected = await showQuickPick(items, {
        placeHolder: 'Select a folder to create a global virtual environment',
        ignoreFocusOut: true,
    });

    if (selected) {
        if (selected.label === 'Browse') {
            const result = await showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder',
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

export async function createPythonVenv(
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    basePythons: PythonEnvironment[],
    venvRoot: Uri,
): Promise<PythonEnvironment | undefined> {
    const filtered = basePythons.filter((e) => e.execInfo);
    if (filtered.length === 0) {
        log.error('No base python found');
        showErrorMessage('No base python found');
        return;
    }

    const basePython = await pickEnvironmentFrom(sortEnvironments(filtered));
    if (!basePython || !basePython.execInfo) {
        log.error('No base python selected, cannot create virtual environment.');
        showErrorMessage('No base python selected, cannot create virtual environment.');
        return;
    }

    const name = await showInputBox({
        prompt: 'Enter name for virtual environment',
        value: '.venv',
        ignoreFocusOut: true,
        validateInput: async (value) => {
            if (!value) {
                return 'Name cannot be empty';
            }
            if (await fsapi.pathExists(path.join(venvRoot.fsPath, value))) {
                return 'Virtual environment already exists';
            }
        },
    });
    if (!name) {
        log.error('No name entered, cannot create virtual environment.');
        showErrorMessage('No name entered, cannot create virtual environment.');
        return;
    }

    const envPath = path.join(venvRoot.fsPath, name);
    const pythonPath =
        os.platform() === 'win32' ? path.join(envPath, 'Scripts', 'python.exe') : path.join(envPath, 'bin', 'python');

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: 'Creating virtual environment',
        },
        async () => {
            try {
                const useUv = await isUvInstalled(log);
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
                        log.error('no python executable found in virtual environment');
                        throw new Error('no python executable found in virtual environment');
                    }
                }

                const resolved = await nativeFinder.resolve(pythonPath);
                if (resolved.version && resolved.executable && resolved.prefix) {
                    const sv = shortVersion(resolved.version);
                    const env = api.createPythonEnvironmentItem(
                        {
                            name: `${name} (${sv})`,
                            displayName: `${name} (${sv})`,
                            shortDisplayName: `${name}:${sv}`,
                            displayPath: pythonPath,
                            version: resolved.version,
                            description: pythonPath,
                            environmentPath: Uri.file(pythonPath),
                            iconPath: Uri.file(path.join(EXTENSION_ROOT_DIR, 'files', 'logo.svg')),
                            sysPrefix: resolved.prefix,
                            execInfo: {
                                run: {
                                    executable: pythonPath,
                                    args: [],
                                },
                            },
                        },
                        manager,
                    );
                    log.info(`Created venv environment: ${name}`);
                    return env;
                } else {
                    throw new Error('Could not resolve the virtual environment');
                }
            } catch (e) {
                log.error(`Failed to create virtual environment: ${e}`);
                showErrorMessage(`Failed to create virtual environment`);
                return;
            }
        },
    );
}

export async function removeVenv(environment: PythonEnvironment, log: LogOutputChannel): Promise<boolean> {
    const pythonPath = os.platform() === 'win32' ? 'python.exe' : 'python';

    const envPath = environment.environmentPath.fsPath.endsWith(pythonPath)
        ? path.dirname(path.dirname(environment.environmentPath.fsPath))
        : environment.environmentPath.fsPath;

    const confirm = await showWarningMessage(`Are you sure you want to remove ${envPath}?`, 'Yes', 'No');
    if (confirm === 'Yes') {
        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Removing virtual environment',
            },
            async () => {
                try {
                    await fsapi.remove(envPath);
                    return true;
                } catch (e) {
                    log.error(`Failed to remove virtual environment: ${e}`);
                    return false;
                }
            },
        );
    }

    return false;
}

function tomlParse(content: string, log?: LogOutputChannel): tomljs.JsonMap {
    try {
        return tomljs.parse(content);
    } catch (err) {
        log?.error('Failed to parse `pyproject.toml`:', err);
    }
    return {};
}

function isPipInstallableToml(toml: tomljs.JsonMap): boolean {
    return toml['build-system'] !== undefined && toml.project !== undefined;
}

function getTomlInstallable(toml: tomljs.JsonMap, tomlPath: Uri): Installable[] {
    const extras: Installable[] = [];

    if (isPipInstallableToml(toml)) {
        extras.push({
            displayName: path.basename(tomlPath.fsPath),
            description: 'Install project as editable',
            group: 'TOML',
            args: ['-e', path.dirname(tomlPath.fsPath)],
            uri: tomlPath,
        });
    }

    if (toml.project && (toml.project as tomljs.JsonMap)['optional-dependencies']) {
        const deps = (toml.project as tomljs.JsonMap)['optional-dependencies'];
        for (const key of Object.keys(deps)) {
            extras.push({
                displayName: key,
                group: 'TOML',
                args: ['-e', `.[${key}]`],
                uri: tomlPath,
            });
        }
    }
    return extras;
}

export async function getProjectInstallable(
    api: PythonEnvironmentApi,
    projects?: PythonProject[],
): Promise<Installable[]> {
    if (!projects) {
        return [];
    }
    const exclude = '**/{.venv*,.git,.nox,.tox,.conda,site-packages,__pypackages__}/**';
    const installable: Installable[] = [];
    await withProgress(
        {
            location: ProgressLocation.Window,
            title: 'Searching dependencies',
        },
        async (progress, token) => {
            progress.report({ message: 'Searching for Requirements and TOML files' });
            const results: Uri[] = (
                await Promise.all([
                    findFiles('**/requirements*.txt', exclude, undefined, token),
                    findFiles('**/requirements/*.txt', exclude, undefined, token),
                    findFiles('**/pyproject.toml', exclude, undefined, token),
                ])
            ).flat();

            const fsPaths = projects.map((p) => p.uri.fsPath);
            const filtered = results
                .filter((uri) => {
                    const p = api.getPythonProject(uri)?.uri.fsPath;
                    return p && fsPaths.includes(p);
                })
                .sort();

            await Promise.all(
                filtered.map(async (uri) => {
                    if (uri.fsPath.endsWith('.toml')) {
                        const toml = tomlParse(await fsapi.readFile(uri.fsPath, 'utf-8'));
                        installable.push(...getTomlInstallable(toml, uri));
                    } else {
                        installable.push({
                            uri,
                            displayName: path.basename(uri.fsPath),
                            group: 'Requirements',
                            args: ['-r', uri.fsPath],
                        });
                    }
                }),
            );
        },
    );
    return installable;
}

export async function resolveVenvPythonEnvironment(
    context: ResolveEnvironmentContext,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    baseManager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    const fsPath = context instanceof Uri ? context.fsPath : context.environmentPath.fsPath;
    const resolved = await resolveVenvPythonEnvironmentPath(fsPath, nativeFinder, api, manager, baseManager);
    return resolved;
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
        const envInfo = getPythonInfo(resolved);
        return api.createPythonEnvironmentItem(envInfo, manager);
    }

    return resolveSystemPythonEnvironmentPath(fsPath, nativeFinder, api, baseManager);
}
