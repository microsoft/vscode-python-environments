import { l10n, LogOutputChannel, ProgressLocation, QuickPickItem, QuickPickItemKind, ThemeIcon, Uri } from 'vscode';
import {
    EnvironmentManager,
    PythonCommandRunConfiguration,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../api';
import * as path from 'path';
import * as os from 'os';
import * as fsapi from 'fs-extra';
import { resolveSystemPythonEnvironmentPath } from './utils';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { isWindows, shortVersion, sortEnvironments } from '../common/utils';
import { getConfiguration } from '../../common/workspace.apis';
import { pickEnvironmentFrom } from '../../common/pickers/environments';
import {
    showQuickPick,
    withProgress,
    showWarningMessage,
    showInputBox,
    showOpenDialog,
} from '../../common/window.apis';
import { showErrorMessage } from '../../common/errors/utils';
import { Common, VenvManagerStrings } from '../../common/localize';
import { isUvInstalled, runUV, runPython } from './helpers';
import { getWorkspacePackagesToInstall } from './pipUtils';

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

function pathForGitBash(binPath: string): string {
    return isWindows() ? binPath.replace(/\\/g, '/') : binPath;
}

async function getPythonInfo(env: NativeEnvInfo): Promise<PythonEnvironmentInfo> {
    if (env.executable && env.version && env.prefix) {
        const venvName = env.name ?? getName(env.executable);
        const sv = shortVersion(env.version);
        const name = `${venvName} (${sv})`;

        const binDir = path.dirname(env.executable);

        interface VenvCommand {
            activate: PythonCommandRunConfiguration;
            deactivate: PythonCommandRunConfiguration;
            /// true if created by the builtin `venv` module and not just the `virtualenv` package.
            supportsStdlib: boolean;
            checkPath?: string;
        }

        const venvManagers: Record<string, VenvCommand> = {
            // Shells supported by the builtin `venv` module
            ['sh']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: true,
            },
            ['bash']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: true,
            },
            ['gitbash']: {
                activate: { executable: 'source', args: [pathForGitBash(path.join(binDir, `activate`))] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: true,
            },
            ['zsh']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: true,
            },
            ['ksh']: {
                activate: { executable: '.', args: [path.join(binDir, `activate`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: true,
            },
            ['pwsh']: {
                activate: { executable: '&', args: [path.join(binDir, `activate.ps1`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: true,
            },
            ['cmd']: {
                activate: { executable: path.join(binDir, `activate.bat`) },
                deactivate: { executable: path.join(binDir, `deactivate.bat`) },
                supportsStdlib: true,
            },
            // Shells supported by the `virtualenv` package
            ['csh']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate.csh`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: false,
                checkPath: path.join(binDir, `activate.csh`),
            },
            ['tcsh']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate.csh`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: false,
                checkPath: path.join(binDir, `activate.csh`),
            },
            ['fish']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate.fish`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: false,
                checkPath: path.join(binDir, `activate.fish`),
            },
            ['xonsh']: {
                activate: { executable: 'source', args: [path.join(binDir, `activate.xsh`)] },
                deactivate: { executable: 'deactivate' },
                supportsStdlib: false,
                checkPath: path.join(binDir, `activate.xsh`),
            },
            ['nu']: {
                activate: { executable: 'overlay', args: ['use', path.join(binDir, 'activate.nu')] },
                deactivate: { executable: 'overlay', args: ['hide', 'activate'] },
                supportsStdlib: false,
                checkPath: path.join(binDir, `activate.nu`),
            },
            // Fallback
            ['unknown']: isWindows()
                ? {
                      activate: { executable: path.join(binDir, `activate`) },
                      deactivate: { executable: path.join(binDir, `deactivate`) },
                      supportsStdlib: true,
                  }
                : {
                      activate: { executable: 'source', args: [path.join(binDir, `activate`)] },
                      deactivate: { executable: 'deactivate' },
                      supportsStdlib: true,
                  },
        } satisfies Record<string, VenvCommand>;

        const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
        const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();

        await Promise.all(
            (Object.entries(venvManagers) as [string, VenvCommand][]).map(async ([shell, mgr]) => {
                if (!mgr.supportsStdlib && mgr.checkPath && !(await fsapi.pathExists(mgr.checkPath))) {
                    return;
                }
                shellActivation.set(shell, [mgr.activate]);
                shellDeactivation.set(shell, [mgr.deactivate]);
            }),
        );

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
            log.warn(`Invalid conda environment: ${JSON.stringify(e)}`);
            continue;
        }

        const env = api.createPythonEnvironmentItem(await getPythonInfo(e), manager);
        collection.push(env);
        log.info(`Found venv environment: ${env.name}`);
    }
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

export async function createPythonVenv(
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    basePythons: PythonEnvironment[],
    venvRoot: Uri,
): Promise<PythonEnvironment | undefined> {
    if (basePythons.length === 0) {
        log.error('No base python found');
        showErrorMessage(VenvManagerStrings.venvErrorNoBasePython);
        return;
    }

    const filtered = basePythons.filter((e) => e.version.startsWith('3.'));
    if (filtered.length === 0) {
        log.error('Did not find any base python 3.*');
        showErrorMessage(VenvManagerStrings.venvErrorNoPython3);
        basePythons.forEach((e) => {
            log.error(`available base python: ${e.version}`);
        });
        return;
    }

    const basePython = await pickEnvironmentFrom(sortEnvironments(filtered));
    if (!basePython || !basePython.execInfo) {
        log.error('No base python selected, cannot create virtual environment.');
        return;
    }

    const name = await showInputBox({
        prompt: VenvManagerStrings.venvName,
        value: '.venv',
        ignoreFocusOut: true,
        validateInput: async (value) => {
            if (!value) {
                return VenvManagerStrings.venvNameErrorEmpty;
            }
            if (await fsapi.pathExists(path.join(venvRoot.fsPath, value))) {
                return VenvManagerStrings.venvNameErrorExists;
            }
        },
    });
    if (!name) {
        log.error('No name entered, cannot create virtual environment.');
        return;
    }

    const envPath = path.join(venvRoot.fsPath, name);
    const pythonPath =
        os.platform() === 'win32' ? path.join(envPath, 'Scripts', 'python.exe') : path.join(envPath, 'bin', 'python');

    const project = api.getPythonProject(venvRoot);
    const packages = await getWorkspacePackagesToInstall(
        api,
        { showSkipOption: true },
        project ? [project] : undefined,
    );

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: VenvManagerStrings.venvCreating,
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
                const env = api.createPythonEnvironmentItem(await getPythonInfo(resolved), manager);
                if (packages && packages?.length > 0) {
                    await api.installPackages(env, packages, { upgrade: false });
                }
                return env;
            } catch (e) {
                log.error(`Failed to create virtual environment: ${e}`);
                showErrorMessage(VenvManagerStrings.venvCreateFailed);
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

    const confirm = await showWarningMessage(
        l10n.t('Are you sure you want to remove {0}?', envPath),
        {
            modal: true,
        },
        { title: Common.yes },
        { title: Common.no, isCloseAffordance: true },
    );
    if (confirm?.title === Common.yes) {
        await withProgress(
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
    }

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
