import * as cp from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import { Uri } from 'vscode';
import which from 'which';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { traceError } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { getUserHomeDir } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import {
    isNativeEnvInfo,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { shortVersion, sortEnvironments } from '../common/utils';

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
export const PIPENV_VENV_IN_PROJECT_KEY = `${ENVS_EXTENSION_ID}:pipenv:VENV_IN_PROJECT`;

let pipenvPath: string | undefined;
let pipenvVenvInProject: boolean | undefined;

export async function clearPipenvCache(): Promise<void> {
    // Reset in-memory cache
    pipenvPath = undefined;
    pipenvVenvInProject = undefined;
}


export async function getPipenv(_nativeFinder: NativePythonFinder): Promise<string | undefined> {
    if (pipenvPath) {
        return pipenvPath;
    }

    const state = await getWorkspacePersistentState();
    const cached = (await state.get(PIPENV_PATH_KEY)) as string | undefined;
    if (cached && (await fs.pathExists(cached))) {
        pipenvPath = cached;
        const venvInProject = await getPipenvVenvInProject(cached);
        pipenvVenvInProject = venvInProject;
        return cached;
    }

    const found = await findPipenv();
    if (found && (await fs.pathExists(found))) {
        pipenvPath = found;
        const venvInProject = await getPipenvVenvInProject(found);
        pipenvVenvInProject = venvInProject;
        await state.set(PIPENV_PATH_KEY, found);
        return found;
    }

    // Try common locations
    const commonPaths = [
        path.join(getUserHomeDir(), '.local', 'bin', 'pipenv'),
        path.join(getUserHomeDir(), '.local', 'bin', 'pipenv.exe'),
        '/usr/local/bin/pipenv',
        '/usr/bin/pipenv',
    ];

    for (const p of commonPaths) {
        if (await fs.pathExists(p)) {
            pipenvPath = p;
            const venvInProject = await getPipenvVenvInProject(p);
            pipenvVenvInProject = venvInProject;
            await state.set(PIPENV_PATH_KEY, p);
            return p;
        }
    }

    return undefined;
}

export async function getPipenvVersion(pipenvPath: string): Promise<string | undefined> {
    try {
        const { stdout } = await exec(`"${pipenvPath}" --version`);
        if (stdout) {
            // pipenv, version 2023.10.24 -> 2023.10.24
            const match = stdout.match(/pipenv, version\s+(\S+)/);
            return match?.[1];
        }
    } catch (ex) {
        traceError('Failed to get pipenv version', ex);
    }
    return undefined;
}

async function getPipenvVenvInProject(pipenvPath: string): Promise<boolean> {
    if (pipenvVenvInProject !== undefined) {
        return pipenvVenvInProject;
    }

    const state = await getWorkspacePersistentState();
    const cached = (await state.get(PIPENV_VENV_IN_PROJECT_KEY)) as boolean | undefined;
    if (cached !== undefined) {
        pipenvVenvInProject = cached;
        return cached;
    }

    try {
        // Use pipenv --support to check for PIPENV_VENV_IN_PROJECT
        const { stdout } = await exec(`"${pipenvPath}" --support`);
        if (stdout) {
            const venvInProject = stdout.includes('PIPENV_VENV_IN_PROJECT: True');
            pipenvVenvInProject = venvInProject;
            await state.set(PIPENV_VENV_IN_PROJECT_KEY, venvInProject);
            return venvInProject;
        } else {
            pipenvVenvInProject = false;
        }
    } catch {
        pipenvVenvInProject = false;
    }

    await state.set(PIPENV_VENV_IN_PROJECT_KEY, pipenvVenvInProject);
    return pipenvVenvInProject;
}

export async function refreshPipenv(
    _forceRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    const pipenv = await getPipenv(nativeFinder);
    if (!pipenv) {
        return [];
    }

    const envs: PythonEnvironment[] = [];

    // Find all pipenv environments
    const globalEnvs = await findPipenvEnvironments(pipenv, nativeFinder, api, manager);
    envs.push(...globalEnvs);

    // Find project-specific environments
    const projects = api.getPythonProjects();
    for (const project of projects) {
        const projectEnv = await resolvePipenvPath(project.uri.fsPath, nativeFinder, api, manager);
        if (projectEnv && !envs.some(e => e.environmentPath.fsPath === projectEnv.environmentPath.fsPath)) {
            envs.push(projectEnv);
        }
    }

    return sortEnvironments(envs);
}

async function findPipenvEnvironments(
    pipenvPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    const envs: PythonEnvironment[] = [];

    try {
        // Try to find global pipenv environments by looking in common virtualenv locations
        const venvInProject = await getPipenvVenvInProject(pipenvPath);
        
        if (venvInProject === true) {
            // When PIPENV_VENV_IN_PROJECT=1, look for .venv directories in projects
            const projects = api.getPythonProjects();
            for (const project of projects) {
                const venvPath = path.join(project.uri.fsPath, '.venv');
                if (await fs.pathExists(venvPath)) {
                    const env = await createPipenvEnvironment(venvPath, project.uri.fsPath, nativeFinder, api, manager);
                    if (env) {
                        envs.push(env);
                    }
                }
            }
        } else {
            // Look in global pipenv virtualenv directory
            const virtualenvsPath = await getPipenvVirtualenvsPath(pipenvPath);
            if (virtualenvsPath && await fs.pathExists(virtualenvsPath)) {
                const entries = await fs.readdir(virtualenvsPath);
                for (const entry of entries) {
                    const envPath = path.join(virtualenvsPath, entry);
                    if (await fs.pathExists(envPath)) {
                        const env = await createPipenvEnvironment(envPath, undefined, nativeFinder, api, manager);
                        if (env) {
                            envs.push(env);
                        }
                    }
                }
            }
        }
    } catch (ex) {
        traceError('Failed to find pipenv environments', ex);
    }

    return envs;
}

async function getPipenvVirtualenvsPath(pipenvPath: string): Promise<string | undefined> {
    try {
        const { stdout } = await exec(`"${pipenvPath}" --support`);
        if (stdout) {
            // Parse the support output to find VIRTUALENV_LOCATION
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.includes('VIRTUALENV_LOCATION')) {
                    const match = line.match(/VIRTUALENV_LOCATION:\s*(.+)/);
                    if (match) {
                        return match[1].trim();
                    }
                }
            }
        }
    } catch (ex) {
        traceError('Failed to get pipenv virtualenvs path', ex);
    }

    // Fallback to common locations
    const homeDir = getUserHomeDir();
    return path.join(homeDir, '.local', 'share', 'virtualenvs');
}

async function createPipenvEnvironment(
    envPath: string,
    projectPath: string | undefined,
    nativeFinder: NativePythonFinder,
    _api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const pythonPath = await findPythonInPipenvEnv(envPath);
        if (!pythonPath || !(await fs.pathExists(pythonPath))) {
            return undefined;
        }

        const envInfo = await nativeFinder.resolve(pythonPath);
        if (!isNativeEnvInfo(envInfo)) {
            return undefined;
        }

        const version = envInfo.version || '0.0.0';
        const prefix = envInfo.prefix || path.dirname(path.dirname(pythonPath));

        const env: PythonEnvironment = {
            envId: { id: `${manager.name}:${envPath}`, managerId: manager.name },
            displayName: projectPath ? path.basename(projectPath) : path.basename(envPath),
            name: projectPath ? path.basename(projectPath) : path.basename(envPath),
            environmentPath: Uri.file(envPath),
            version: shortVersion(version),
            group: projectPath ? path.basename(projectPath) : PIPENV_GLOBAL,
            description: `Pipenv environment at ${envPath}`,
            displayPath: envPath,
            sysPrefix: prefix,
            execInfo: {
                run: {
                    executable: pythonPath,
                    args: []
                }
            }
        };

        return env;
    } catch (ex) {
        traceError(`Failed to create pipenv environment for ${envPath}`, ex);
        return undefined;
    }
}

async function findPythonInPipenvEnv(envPath: string): Promise<string | undefined> {
    // Look for python executable in the virtual environment
    const possiblePaths = isWindows()
        ? [
              path.join(envPath, 'Scripts', 'python.exe'),
              path.join(envPath, 'Scripts', 'python3.exe'),
              path.join(envPath, 'bin', 'python'),
              path.join(envPath, 'bin', 'python3'),
          ]
        : [
              path.join(envPath, 'bin', 'python'),
              path.join(envPath, 'bin', 'python3'),
              path.join(envPath, 'Scripts', 'python.exe'),
              path.join(envPath, 'Scripts', 'python3.exe'),
          ];

    for (const pythonPath of possiblePaths) {
        if (await fs.pathExists(pythonPath)) {
            return pythonPath;
        }
    }

    return undefined;
}

export async function resolvePipenvPath(
    projectPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    const pipenv = await getPipenv(nativeFinder);
    if (!pipenv) {
        return undefined;
    }

    try {
        // Check if this is a pipenv project (has Pipfile)
        const pipfilePath = path.join(projectPath, 'Pipfile');
        if (!(await fs.pathExists(pipfilePath))) {
            return undefined;
        }

        // Get the virtual environment path for this project
        const { stdout } = await exec(`"${pipenv}" --venv`, { cwd: projectPath });
        if (!stdout) {
            return undefined;
        }

        const venvPath = stdout.trim();
        if (!venvPath || !(await fs.pathExists(venvPath))) {
            return undefined;
        }

        return await createPipenvEnvironment(venvPath, projectPath, nativeFinder, api, manager);
    } catch (ex) {
        traceError(`Failed to resolve pipenv path for ${projectPath}`, ex);
        return undefined;
    }
}

export async function getPipenvForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return state.get<string>(PIPENV_GLOBAL_KEY);
}

export async function setPipenvForGlobal(environmentPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    if (environmentPath) {
        await state.set(PIPENV_GLOBAL_KEY, environmentPath);
    } else {
        // Just set it to undefined to remove it
        await state.set(PIPENV_GLOBAL_KEY, undefined);
    }
}

export async function getPipenvForWorkspace(workspacePath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const workspaces = (await state.get(PIPENV_WORKSPACE_KEY)) as Record<string, string> | undefined;
    return workspaces?.[workspacePath];
}

export async function setPipenvForWorkspace(
    workspacePath: string,
    environmentPath: string | undefined,
): Promise<void> {
    const state = await getWorkspacePersistentState();
    const workspaces: Record<string, string> = ((await state.get(PIPENV_WORKSPACE_KEY)) as Record<string, string>) ?? {};

    if (environmentPath) {
        workspaces[workspacePath] = environmentPath;
    } else {
        delete workspaces[workspacePath];
    }

    await state.set(PIPENV_WORKSPACE_KEY, workspaces);
}

export async function setPipenvForWorkspaces(
    workspacePaths: string[],
    environmentPath: string | undefined,
): Promise<void> {
    const state = await getWorkspacePersistentState();
    const workspaces: Record<string, string> = ((await state.get(PIPENV_WORKSPACE_KEY)) as Record<string, string>) ?? {};

    for (const workspacePath of workspacePaths) {
        if (environmentPath) {
            workspaces[workspacePath] = environmentPath;
        } else {
            delete workspaces[workspacePath];
        }
    }

    await state.set(PIPENV_WORKSPACE_KEY, workspaces);
}