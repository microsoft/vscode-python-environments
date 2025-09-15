import * as fs from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import which from 'which';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../api';
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
import { shortVersion, sortEnvironments } from '../common/utils';

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
    pipenvPath = await state.get(PIPENV_PATH_KEY);

    if (pipenvPath && (await fs.pathExists(pipenvPath))) {
        return pipenvPath;
    }

    const found = await findPipenv();
    if (found) {
        await setPipenv(found);
        return found;
    }

    // If native finder is available, try to find pipenv through it
    if (native) {
        try {
            // Try to get manager info (this is a simplified approach)
            const data = await native.refresh(false);
            for (const info of data) {
                if (!isNativeEnvInfo(info)) {
                    const mgr = info as NativeEnvManagerInfo;
                    if (mgr.tool === 'pipenv' && mgr.executable && (await fs.pathExists(mgr.executable))) {
                        await setPipenv(mgr.executable);
                        return mgr.executable;
                    }
                }
            }
        } catch (_error) {
            // Ignore errors here as this is a fallback
        }
    }

    return undefined;
}

export async function getPipenvVersion(pipenvPath: string): Promise<string | undefined> {
    try {
        const result = await new Promise<string>((resolve, reject) => {
            require('child_process').exec(
                `"${pipenvPath}" --version`,
                { timeout: 30000 },
                (error: Error | null, stdout: string, _stderr: string) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(stdout);
                    }
                }
            );
        });

        // Pipenv version output looks like: "pipenv, version 2023.10.24"
        const match = result.match(/pipenv,?\s+version\s+([^\s\n]+)/i);
        return match ? match[1].trim() : undefined;
    } catch (error) {
        traceError('Failed to get pipenv version:', error);
        return undefined;
    }
}

export async function refreshPipenv(
    clearCache: boolean,
    native: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    if (clearCache) {
        await clearPipenvCache();
    }

    const environments: PythonEnvironment[] = [];

    try {
        const pipenv = await getPipenv(native);
        if (!pipenv) {
            return environments;
        }

        // Get pipenv environments from native finder
        const envInfos = await native.refresh(false, NativePythonEnvironmentKind.pipenv);

        for (const envInfo of envInfos) {
            if (!isNativeEnvInfo(envInfo)) {
                continue;
            }

            const env = await createPythonEnvironment(envInfo as NativeEnvInfo, api, manager);
            if (env) {
                environments.push(env);
            }
        }

        traceInfo(`Found ${environments.length} pipenv environments`);
        return sortEnvironments(environments);
    } catch (error) {
        traceError('Error refreshing pipenv environments:', error);
        return environments;
    }
}

async function createPythonEnvironment(
    envInfo: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        if (!envInfo.prefix || !envInfo.executable || !envInfo.version) {
            traceError(`Incomplete pipenv environment info: ${JSON.stringify(envInfo)}`);
            return undefined;
        }

        const envPath = Uri.file(envInfo.prefix);
        const interpreterPath = Uri.file(envInfo.executable);

        // Determine if this is a project-local environment
        const projectPath = findProjectPath(envInfo.prefix);
        const group = projectPath ? path.basename(projectPath) : PIPENV_GLOBAL;

        const sv = shortVersion(envInfo.version);
        const name = envInfo.name || envInfo.displayName || path.basename(envInfo.prefix);
        const displayName = envInfo.displayName || `pipenv (${sv})`;

        const environment: PythonEnvironmentInfo = {
            name,
            displayName,
            displayPath: envPath.fsPath,
            version: sv,
            environmentPath: envPath,
            execInfo: {
                run: {
                    executable: interpreterPath.fsPath,
                },
            },
            sysPrefix: envInfo.prefix,
            group,
        };

        return api.createPythonEnvironmentItem(environment, manager);
    } catch (error) {
        traceError('Error creating pipenv environment:', error);
        return undefined;
    }
}

function findProjectPath(envPrefix: string | undefined): string | undefined {
    if (!envPrefix) {
        return undefined;
    }

    // Pipenv environments are typically created in a central location like ~/.local/share/virtualenvs/
    // The environment name usually contains a hash of the project path
    // We need to find the actual project by looking for Pipfile
    try {
        // For now, we'll try to infer the project path from the environment name
        // This is a simplified approach - in a real implementation, you might want to
        // query pipenv directly for the project path
        const envName = path.basename(envPrefix);
        const hashMatch = envName.match(/^(.+)-([a-f0-9]{8})$/);
        
        if (hashMatch) {
            // This is a simplified approach - you might want to maintain a mapping
            // or query pipenv for the actual project paths
            return undefined; // For now, return undefined as we can't reliably determine the project path
        }
    } catch (error) {
        traceError('Error finding project path for pipenv environment:', error);
    }

    return undefined;
}

export async function resolvePipenvPath(
    pipenvPath: string,
    native: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const envInfo = await native.resolve(pipenvPath);
        if (envInfo && envInfo.kind === NativePythonEnvironmentKind.pipenv) {
            return await createPythonEnvironment(envInfo, api, manager);
        }

        return undefined;
    } catch (error) {
        traceError('Error resolving pipenv path:', error);
        return undefined;
    }
}