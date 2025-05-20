import * as fs from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import which from 'which';
import {
    EnvironmentManager,
    PythonCommandRunConfiguration,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../api';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { traceError, traceInfo } from '../../common/logging';
import { getGlobalPersistentState, getWorkspacePersistentState } from '../../common/persistentState';
import { getUserHomeDir, untildify } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import { ShellConstants } from '../../features/common/shellConstants';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { shortVersion, sortEnvironments } from '../common/utils';

async function findPoetry(): Promise<string | undefined> {
    try {
        return await which('poetry');
    } catch {
        return undefined;
    }
}

export const POETRY_ENVIRONMENTS = 'Environments';

export const POETRY_PATH_KEY = `${ENVS_EXTENSION_ID}:poetry:POETRY_PATH`;
export const POETRY_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:poetry:WORKSPACE_SELECTED`;
export const POETRY_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:poetry:GLOBAL_SELECTED`;

let poetryPath: string | undefined;
export async function clearPoetryCache(): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.clear([POETRY_WORKSPACE_KEY, POETRY_GLOBAL_KEY]);
    const global = await getGlobalPersistentState();
    await global.clear([POETRY_PATH_KEY]);
}

async function setPoetry(poetry: string): Promise<void> {
    poetryPath = poetry;
    const state = await getWorkspacePersistentState();
    await state.set(POETRY_PATH_KEY, poetry);
}

export async function getPoetryForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return await state.get(POETRY_GLOBAL_KEY);
}

export async function setPoetryForGlobal(poetryPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(POETRY_GLOBAL_KEY, poetryPath);
}

export async function getPoetryForWorkspace(fsPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(POETRY_WORKSPACE_KEY);
    if (data) {
        try {
            return data[fsPath];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setPoetryForWorkspace(fsPath: string, envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(POETRY_WORKSPACE_KEY)) ?? {};
    if (envPath) {
        data[fsPath] = envPath;
    } else {
        delete data[fsPath];
    }
    await state.set(POETRY_WORKSPACE_KEY, data);
}

export async function setPoetryForWorkspaces(fsPath: string[], envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(POETRY_WORKSPACE_KEY)) ?? {};
    fsPath.forEach((s) => {
        if (envPath) {
            data[s] = envPath;
        } else {
            delete data[s];
        }
    });
    await state.set(POETRY_WORKSPACE_KEY, data);
}

export async function getPoetry(native?: NativePythonFinder): Promise<string | undefined> {
    if (poetryPath) {
        return poetryPath;
    }

    const state = await getWorkspacePersistentState();
    poetryPath = await state.get<string>(POETRY_PATH_KEY);
    if (poetryPath) {
        traceInfo(`Using poetry from persistent state: ${poetryPath}`);
        return untildify(poetryPath);
    }
    
    // Check in standard PATH locations
    poetryPath = await findPoetry();
    if (poetryPath) {
        await setPoetry(poetryPath);
        return poetryPath;
    }

    // Check for user-installed poetry
    const home = getUserHomeDir();
    if (home) {
        const poetryUserInstall = path.join(
            home,
            isWindows() ? 'AppData\\Roaming\\Python\\Scripts\\poetry.exe' : '.local/bin/poetry'
        );
        if (await fs.exists(poetryUserInstall)) {
            poetryPath = poetryUserInstall;
            await setPoetry(poetryPath);
            return poetryPath;
        }
    }

    if (native) {
        const data = await native.refresh(false);
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'poetry');
        if (managers.length > 0) {
            poetryPath = managers[0].executable;
            traceInfo(`Using poetry from native finder: ${poetryPath}`);
            await state.set(POETRY_PATH_KEY, poetryPath);
            return poetryPath;
        }
    }

    return undefined;
}

function createShellActivation(poetry: string, _prefix: string): Map<string, PythonCommandRunConfiguration[]> {
    const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();


    shellActivation.set(ShellConstants.BASH, [
        { executable: 'eval', args: [`$(${poetry} env activate)`] }
    ]);

    shellActivation.set(ShellConstants.ZSH, [
        { executable: 'eval', args: [`$(${poetry} env activate)`] }
    ]);

    shellActivation.set(ShellConstants.SH, [
        { executable: 'eval', args: [`$(${poetry} env activate)`] }
    ]);

    shellActivation.set(ShellConstants.GITBASH, [
        { executable: 'eval', args: [`$(${poetry} env activate)`] }
    ]);

    shellActivation.set(ShellConstants.FISH, [
        { executable: 'eval', args: [`(${poetry} env activate)`] }
    ]);

    shellActivation.set(ShellConstants.PWSH, [
        { executable: '&', args: [`${poetry} env activate | Invoke-Expression`] }
    ]);

    if (isWindows()) {
        shellActivation.set(ShellConstants.CMD, [
            { executable: 'for', args: ['/f', '"%i"', 'in', `('"${poetry}" env activate')`, 'do', '%i'] }
        ]);
    }

    shellActivation.set(ShellConstants.NU, [
        { executable: `${poetry} env activate | str trim | shells nu -c $in` }
    ]);
    
    shellActivation.set('unknown', [
        { executable: 'eval', args: [`$(${poetry} env activate)`] }
    ]);

    return shellActivation;
}

function createShellDeactivation(): Map<string, PythonCommandRunConfiguration[]> {
    const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    
    // Poetry doesn't have a standard deactivation command like venv does
    // The best approach is to exit the shell or start a new one
    shellDeactivation.set('unknown', [{ executable: 'exit' }]);
    
    shellDeactivation.set(ShellConstants.BASH, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.ZSH, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.SH, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.GITBASH, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.FISH, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.PWSH, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.CMD, [{ executable: 'exit' }]);
    shellDeactivation.set(ShellConstants.NU, [{ executable: 'exit' }]);
    
    return shellDeactivation;
}

function nativeToPythonEnv(
    info: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    _poetry: string,
): PythonEnvironment | undefined {
    if (!(info.prefix && info.executable && info.version)) {
        traceError(`Incomplete poetry environment info: ${JSON.stringify(info)}`);
        return undefined;
    }

    const sv = shortVersion(info.version);
    const name = info.name || info.displayName || path.basename(info.prefix);
    const displayName = info.displayName || `poetry (${sv})`;

    const shellActivation = createShellActivation(_poetry, info.prefix);
    const shellDeactivation = createShellDeactivation();
                
    const environment: PythonEnvironmentInfo = {
        name: name,
        displayName: displayName,
        shortDisplayName: displayName,
        displayPath: info.prefix,
        version: info.version,
        environmentPath: Uri.file(info.prefix),
        description: undefined,
        tooltip: info.prefix,
        execInfo: {
            run: { executable: info.executable },
            shellActivation,
            shellDeactivation,
        },
        sysPrefix: info.prefix,
        group: POETRY_ENVIRONMENTS,
    };

    return api.createPythonEnvironmentItem(environment, manager);
}

export async function refreshPoetry(
    hardRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    traceInfo('Refreshing poetry environments');
    const data = await nativeFinder.refresh(hardRefresh);

    let poetry = await getPoetry();

    if (poetry === undefined) {
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'poetry');
        if (managers.length > 0) {
            poetry = managers[0].executable;
            await setPoetry(poetry);
        }
    }

    if (!poetry) {
        traceInfo('Poetry executable not found');
        return [];
    }


    const envs = data
        .filter((e) => isNativeEnvInfo(e))
        .map((e) => e as NativeEnvInfo)
        .filter((e) => e.kind === NativePythonEnvironmentKind.poetry);

    const collection: PythonEnvironment[] = [];

    envs.forEach((e) => {
        if (poetry) {
            const environment = nativeToPythonEnv(e, api, manager, poetry);
            if (environment) {
                
                collection.push(environment);
            }
        }
    });

    return sortEnvironments(collection);
}

export async function resolvePoetryPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const e = await nativeFinder.resolve(fsPath);
        if (e.kind !== NativePythonEnvironmentKind.poetry) {
            return undefined;
        }
        const poetry = await getPoetry(nativeFinder);
        if (!poetry) {
            traceError('Poetry not found while resolving environment');
            return undefined;
        }

        return nativeToPythonEnv(e, api, manager, poetry);
    } catch {
        return undefined;
    }
}
