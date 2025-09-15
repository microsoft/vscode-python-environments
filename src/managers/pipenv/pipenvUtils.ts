import * as cp from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import { Uri } from 'vscode';
import which from 'which';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../api';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { traceError, traceInfo } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { getUserHomeDir, untildify } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getShellActivationCommands, shortVersion, sortEnvironments } from '../common/utils';

const exec = promisify(cp.exec);

async function findPipenv(): Promise<string | undefined> {
    try {
        return await which('pipenv');
    } catch {
        return undefined;
    }
}

export const PIPENV_GLOBAL = 'Global';

export const PIPENV_PATH_KEY = `${ENVS_EXTENSION_ID}:pipenv:PIPENV_PATH`;
export const PIPENV_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:pipenv:WORKSPACE_SELECTED`;
export const PIPENV_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:pipenv:GLOBAL_SELECTED`;

let pipenvPath: string | undefined;

export async function clearPipenvCache(): Promise<void> {
    // Reset in-memory cache
    pipenvPath = undefined;
}

async function setPipenv(pipenv: string): Promise<void> {
    pipenvPath = pipenv;
    const state = await getWorkspacePersistentState();
    await state.set(PIPENV_PATH_KEY, pipenv);
}

export async function getPipenvForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return await state.get(PIPENV_GLOBAL_KEY);
}

export async function setPipenvForGlobal(pipenvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(PIPENV_GLOBAL_KEY, pipenvPath);
}

export async function getPipenvForWorkspace(fsPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(PIPENV_WORKSPACE_KEY);
    if (data) {
        try {
            return data[fsPath];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setPipenvForWorkspace(fsPath: string, envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(PIPENV_WORKSPACE_KEY)) ?? {};
    if (envPath) {
        data[fsPath] = envPath;
    } else {
        delete data[fsPath];
    }
    await state.set(PIPENV_WORKSPACE_KEY, data);
}

export async function setPipenvForWorkspaces(fsPath: string[], envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(PIPENV_WORKSPACE_KEY)) ?? {};
    fsPath.forEach((s) => {
        if (envPath) {
            data[s] = envPath;
        } else {
            delete data[s];
        }
    });
    await state.set(PIPENV_WORKSPACE_KEY, data);
}

export async function getPipenv(native?: NativePythonFinder): Promise<string | undefined> {
    if (pipenvPath) {
        return pipenvPath;
    }

    const state = await getWorkspacePersistentState();
    pipenvPath = await state.get<string>(PIPENV_PATH_KEY);
    if (pipenvPath) {
        traceInfo(`Using pipenv from persistent state: ${pipenvPath}`);
        return untildify(pipenvPath);
    }

    // Check in standard PATH locations
    const found = await findPipenv();
    if (found) {
        await setPipenv(found);
        return found;
    }

    // Check for user-installed pipenv
    const home = getUserHomeDir();
    if (home) {
        const pipenvUserInstall = path.join(
            home,
            isWindows() ? 'AppData\\Roaming\\Python\\Scripts\\pipenv.exe' : '.local/bin/pipenv',
        );
        if (await fs.pathExists(pipenvUserInstall)) {
            pipenvPath = pipenvUserInstall;
            await setPipenv(pipenvPath);
            return pipenvPath;
        }
    }

    if (native) {
        const data = await native.refresh(false);
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'pipenv');
        if (managers.length > 0) {
            pipenvPath = managers[0].executable;
            traceInfo(`Using pipenv from native finder: ${pipenvPath}`);
            await setPipenv(pipenvPath);
            return pipenvPath;
        }
    }

    return undefined;
}

export async function getPipenvVersion(pipenvExe: string): Promise<string | undefined> {
    try {
        const { stdout } = await exec(`"${pipenvExe}" --version`);
        // pipenv version output: "pipenv, version 2023.12.1"
        const match = stdout.match(/pipenv, version (.+)/);
        return match?.[1]?.trim();
    } catch (ex) {
        traceError('Failed to get pipenv version', ex);
        return undefined;
    }
}

async function nativeToPythonEnv(
    info: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    _pipenv: string,
): Promise<PythonEnvironment | undefined> {
    if (!(info.prefix && info.executable && info.version)) {
        traceError(`Incomplete pipenv environment info: ${JSON.stringify(info)}`);
        return undefined;
    }

    const sv = shortVersion(info.version);
    const name = info.name || info.displayName || path.basename(info.prefix);
    let displayName = info.displayName || `pipenv (${sv})`;
    
    // If this is a project-specific pipenv, show the project name
    if (info.project) {
        const projectName = path.basename(info.project);
        displayName = `pipenv (${projectName})`;
    }

    // Get generic python environment info to access shell activation/deactivation commands
    const binDir = path.dirname(info.executable);
    const { shellActivation, shellDeactivation } = await getShellActivationCommands(binDir);

    const environment: PythonEnvironmentInfo = {
        name: name,
        displayName: displayName,
        shortDisplayName: displayName,
        displayPath: info.prefix,
        version: info.version,
        environmentPath: Uri.file(info.prefix),
        description: info.project ? `Project: ${info.project}` : undefined,
        tooltip: info.prefix,
        execInfo: {
            run: { executable: info.executable },
            shellActivation,
            shellDeactivation,
        },
        sysPrefix: info.prefix,
        group: info.project ? path.basename(info.project) : PIPENV_GLOBAL,
    };

    return api.createPythonEnvironmentItem(environment, manager);
}

export async function refreshPipenv(
    hardRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    traceInfo('Refreshing pipenv environments');
    const data = await nativeFinder.refresh(hardRefresh);

    let pipenv = await getPipenv();

    if (pipenv === undefined) {
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'pipenv');
        if (managers.length > 0) {
            pipenv = managers[0].executable;
            traceInfo(`Found pipenv at ${pipenv}`);
        }
    }

    if (!pipenv) {
        traceInfo('pipenv not found');
        return [];
    }

    const environments: PythonEnvironment[] = [];
    const environmentInfos = data.filter(isNativeEnvInfo).filter((e) => e.kind === NativePythonEnvironmentKind.pipenv);

    for (const info of environmentInfos) {
        try {
            const env = await nativeToPythonEnv(info, api, manager, pipenv);
            if (env) {
                environments.push(env);
            }
        } catch (ex) {
            traceError(`Error converting pipenv environment: ${info.executable}`, ex);
        }
    }

    return sortEnvironments(environments);
}

export async function resolvePipenvPath(
    interpreterPath: Uri,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
): Promise<PythonEnvironment | undefined> {
    const infos = await nativeFinder.resolve(interpreterPath);
    for (const info of infos) {
        if (isNativeEnvInfo(info) && info.kind === NativePythonEnvironmentKind.pipenv) {
            const pythonEnvInfo = envToEnvInfo(info, api);
            if (pythonEnvInfo) {
                const resolved = await api.resolve([pythonEnvInfo]);
                return resolved.length > 0 ? resolved[0] : undefined;
            }
        }
    }
    return undefined;
}

function envToEnvInfo(info: NativeEnvInfo, api: PythonEnvironmentApi): PythonEnvironmentInfo | undefined {
    if (!info.executable) {
        return undefined;
    }

    const executable = Uri.file(info.executable);
    let displayName: string | undefined;
    
    if (info.project) {
        // Extract project name from path for display
        const projectName = path.basename(info.project);
        displayName = `pipenv (${projectName})`;
    } else {
        displayName = info.displayName ?? 'pipenv';
    }

    const version = info.version ? shortVersion(info.version) : undefined;

    return {
        id: `pipenv:${info.executable}`,
        displayName,
        name: displayName,
        executable,
        version,
        arch: info.arch,
        kind: 'ms-python.python:pipenv',
        projectPath: info.project ? Uri.file(info.project) : undefined,
        distroOrgName: 'pipenv',
    };
}