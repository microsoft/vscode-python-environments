// Utility functions for Pipenv environment management

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
import { getWorkspacePersistentState } from '../../common/persistentState';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { shortVersion } from '../common/utils';

export const PIPENV_PATH_KEY = `${ENVS_EXTENSION_ID}:pipenv:PIPENV_PATH`;
export const PIPENV_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:pipenv:WORKSPACE_SELECTED`;
export const PIPENV_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:pipenv:GLOBAL_SELECTED`;

let pipenvPath: string | undefined;

async function findPipenv(): Promise<string | undefined> {
    try {
        return await which('pipenv');
    } catch {
        return undefined;
    }
}

async function setPipenv(pipenv: string): Promise<void> {
    pipenvPath = pipenv;
    const state = await getWorkspacePersistentState();
    await state.set(PIPENV_PATH_KEY, pipenv);
}

export async function clearPipenvCache(): Promise<void> {
    pipenvPath = undefined;
}

export async function getPipenv(native?: NativePythonFinder): Promise<string | undefined> {
    if (pipenvPath) {
        return pipenvPath;
    }

    const state = await getWorkspacePersistentState();
    pipenvPath = await state.get(PIPENV_PATH_KEY);
    if (pipenvPath) {
        return pipenvPath;
    }

    pipenvPath = await findPipenv();
    if (pipenvPath) {
        await setPipenv(pipenvPath);
        return pipenvPath;
    }

    if (native) {
        // Try to use native finder to locate pipenv
        try {
            const data = await native.refresh(false);
            const managers = data
                .filter((e) => !isNativeEnvInfo(e))
                .map((e) => e as NativeEnvManagerInfo)
                .filter((e) => e.tool.toLowerCase() === 'pipenv');
            if (managers.length > 0 && managers[0].executable) {
                pipenvPath = managers[0].executable;
                await setPipenv(pipenvPath);
                return pipenvPath;
            }
        } catch (ex) {
            traceError('Failed to get pipenv from native finder', ex);
        }
    }

    return undefined;
}

function nativeToPythonEnv(
    info: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): PythonEnvironment | undefined {
    if (!(info.prefix && info.executable && info.version)) {
        traceError(`Incomplete pipenv environment info: ${JSON.stringify(info)}`);
        return undefined;
    }

    const sv = shortVersion(info.version);
    const name = info.name || info.displayName || path.basename(info.prefix);
    const displayName = info.displayName || `pipenv (${sv})`;

    const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();

    shellActivation.set('unknown', [{ executable: 'pipenv', args: ['shell'] }]);
    shellDeactivation.set('unknown', [{ executable: 'deactivate', args: [] }]);

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
        group: 'Pipenv',
    };

    return api.createPythonEnvironmentItem(environment, manager);
}

export async function refreshPipenv(
    hardRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    const pipenv = await getPipenv(nativeFinder);
    if (!pipenv) {
        traceInfo('Pipenv not found, returning empty environment list');
        return [];
    }

    try {
        const data = await nativeFinder.refresh(hardRefresh);

        const envs = data
            .filter((e) => isNativeEnvInfo(e))
            .map((e) => e as NativeEnvInfo)
            .filter((e) => e.kind === NativePythonEnvironmentKind.pipenv);

        const pythonEnvs: PythonEnvironment[] = [];

        envs.forEach((env) => {
            const pythonEnv = nativeToPythonEnv(env, api, manager);
            if (pythonEnv) {
                pythonEnvs.push(pythonEnv);
            }
        });

        traceInfo(`Found ${pythonEnvs.length} pipenv environments`);
        return pythonEnvs;
    } catch (ex) {
        traceError('Failed to refresh pipenv environments', ex);
        return [];
    }
}

export async function resolvePipenvPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const resolved = await nativeFinder.resolve(fsPath);

        if (resolved.kind === NativePythonEnvironmentKind.pipenv) {
            const pipenv = await getPipenv(nativeFinder);
            if (pipenv) {
                return nativeToPythonEnv(resolved, api, manager);
            }
        }

        return undefined;
    } catch {
        return undefined;
    }
}

// Persistence functions for workspace/global environment selection
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
    const data: { [key: string]: string } = (await state.get(PIPENV_WORKSPACE_KEY)) ?? {};
    return data[fsPath];
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