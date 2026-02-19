import * as fs from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import which from 'which';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../api';
import { execProcess } from '../../common/childProcess.apis';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { traceError, traceInfo } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { getUserHomeDir, normalizePath, untildify } from '../../common/utils/pathUtils';
import { isMac, isWindows } from '../../common/utils/platformUtils';
import { getSettingWorkspaceScope } from '../../features/settings/settingHelpers';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getShellActivationCommands, shortVersion, sortEnvironments } from '../common/utils';

/**
 * Checks if the POETRY_VIRTUALENVS_IN_PROJECT environment variable is set to a truthy value.
 * When true, Poetry creates virtualenvs in the project's `.venv` directory.
 * Mirrors the PET server logic in `pet-poetry/src/env_variables.rs`.
 * @param envValue Optional override for the env var value (used for testing).
 */
export function isPoetryVirtualenvsInProject(envValue?: string): boolean {
    const value = envValue ?? process.env.POETRY_VIRTUALENVS_IN_PROJECT;
    if (value === undefined) {
        return false;
    }
    return value === '1' || value.toLowerCase() === 'true';
}

async function findPoetry(): Promise<string | undefined> {
    try {
        return await which('poetry');
    } catch {
        return undefined;
    }
}

export const POETRY_GLOBAL = 'Global';

export const POETRY_PATH_KEY = `${ENVS_EXTENSION_ID}:poetry:POETRY_PATH`;
export const POETRY_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:poetry:WORKSPACE_SELECTED`;
export const POETRY_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:poetry:GLOBAL_SELECTED`;
export const POETRY_VIRTUALENVS_PATH_KEY = `${ENVS_EXTENSION_ID}:poetry:VIRTUALENVS_PATH`;

let poetryPath: string | undefined;
let poetryVirtualenvsPath: string | undefined;

function getPoetryPathFromSettings(): string | undefined {
    const poetryPath = getSettingWorkspaceScope<string>('python', 'poetryPath');
    return poetryPath ? poetryPath : undefined;
}

export async function clearPoetryCache(): Promise<void> {
    // Reset in-memory cache
    poetryPath = undefined;
    poetryVirtualenvsPath = undefined;
}

async function setPoetry(poetry: string): Promise<void> {
    poetryPath = poetry;
    const state = await getWorkspacePersistentState();
    await state.set(POETRY_PATH_KEY, poetry);

    // Also get and cache the virtualenvs path
    await getPoetryVirtualenvsPath(poetry);
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
    // Priority 1: Settings (if explicitly set and valid)
    const settingPath = getPoetryPathFromSettings();
    if (settingPath) {
        if (await fs.exists(untildify(settingPath))) {
            traceInfo(`Using poetry from settings: ${settingPath}`);
            return untildify(settingPath);
        }
        traceInfo(`Poetry path from settings does not exist: ${settingPath}`);
    }

    // Priority 2: In-memory cache
    if (poetryPath) {
        if (await fs.exists(untildify(poetryPath))) {
            return untildify(poetryPath);
        }
        poetryPath = undefined;
    }

    // Priority 3: Persistent state
    const state = await getWorkspacePersistentState();
    const storedPath = await state.get<string>(POETRY_PATH_KEY);
    if (storedPath) {
        if (await fs.exists(untildify(storedPath))) {
            poetryPath = storedPath;
            traceInfo(`Using poetry from persistent state: ${poetryPath}`);
            // Also retrieve the virtualenvs path if we haven't already
            if (!poetryVirtualenvsPath) {
                getPoetryVirtualenvsPath(untildify(poetryPath)).catch((e) =>
                    traceError(`Error getting Poetry virtualenvs path: ${e}`),
                );
            }
            return untildify(poetryPath);
        }
        await state.set(POETRY_PATH_KEY, undefined);
    }

    // Priority 4: PATH lookup
    poetryPath = await findPoetry();
    if (poetryPath) {
        await setPoetry(poetryPath);
        return poetryPath;
    }

    // Priority 5: Known user-install locations
    const home = getUserHomeDir();
    if (home) {
        const poetryUserInstall = path.join(
            home,
            isWindows() ? 'AppData\\Roaming\\Python\\Scripts\\poetry.exe' : '.local/bin/poetry',
        );
        if (await fs.exists(poetryUserInstall)) {
            poetryPath = poetryUserInstall;
            await setPoetry(poetryPath);
            return poetryPath;
        }
    }

    // Priority 6: Native finder as fallback
    if (native) {
        const data = await native.refresh(false);
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'poetry');
        if (managers.length > 0) {
            poetryPath = managers[0].executable;
            traceInfo(`Using poetry from native finder: ${poetryPath}`);
            await setPoetry(poetryPath);
            return poetryPath;
        }
    }

    return undefined;
}

export async function getPoetryVirtualenvsPath(poetryExe?: string): Promise<string | undefined> {
    if (poetryVirtualenvsPath) {
        return poetryVirtualenvsPath;
    }

    // Check if we have it in persistent state
    const state = await getWorkspacePersistentState();
    poetryVirtualenvsPath = await state.get<string>(POETRY_VIRTUALENVS_PATH_KEY);
    if (poetryVirtualenvsPath) {
        return untildify(poetryVirtualenvsPath);
    }

    // Try to get it from poetry config
    const poetry = poetryExe || (await getPoetry());
    if (poetry) {
        try {
            const { stdout } = await execProcess(`"${poetry}" config virtualenvs.path`);
            if (stdout) {
                const venvPath = stdout.trim();
                // Poetry might return the path with placeholders like {cache-dir}
                // Resolve the placeholder if present
                if (venvPath.includes('{cache-dir}')) {
                    poetryVirtualenvsPath = await resolveVirtualenvsPath(poetry, venvPath);
                } else if (path.isAbsolute(venvPath)) {
                    poetryVirtualenvsPath = venvPath;
                } else {
                    // Not an absolute path and no placeholder, use platform-specific default
                    poetryVirtualenvsPath = getDefaultPoetryVirtualenvsPath();
                }

                if (poetryVirtualenvsPath) {
                    await state.set(POETRY_VIRTUALENVS_PATH_KEY, poetryVirtualenvsPath);
                    return poetryVirtualenvsPath;
                }
            }
        } catch (e) {
            traceError(`Error getting Poetry virtualenvs path: ${e}`);
        }
    }

    // Fallback to platform-specific default location
    poetryVirtualenvsPath = getDefaultPoetryVirtualenvsPath();
    if (poetryVirtualenvsPath) {
        await state.set(POETRY_VIRTUALENVS_PATH_KEY, poetryVirtualenvsPath);
        return poetryVirtualenvsPath;
    }

    return undefined;
}

/**
 * Returns the default Poetry cache directory based on the current platform.
 * - Windows: %LOCALAPPDATA%\pypoetry\Cache or %APPDATA%\pypoetry\Cache
 * - macOS: ~/Library/Caches/pypoetry
 * - Linux: ~/.cache/pypoetry
 */
export function getDefaultPoetryCacheDir(): string | undefined {
    if (isWindows()) {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            return path.join(localAppData, 'pypoetry', 'Cache');
        }
        const appData = process.env.APPDATA;
        if (appData) {
            return path.join(appData, 'pypoetry', 'Cache');
        }
        return undefined;
    }

    const home = getUserHomeDir();
    if (!home) {
        return undefined;
    }

    if (isMac()) {
        return path.join(home, 'Library', 'Caches', 'pypoetry');
    }

    // Linux default
    return path.join(home, '.cache', 'pypoetry');
}

/**
 * Returns the default Poetry virtualenvs path based on the current platform.
 * - Windows: %LOCALAPPDATA%\pypoetry\Cache\virtualenvs or %APPDATA%\pypoetry\Cache\virtualenvs
 * - macOS: ~/Library/Caches/pypoetry/virtualenvs
 * - Linux: ~/.cache/pypoetry/virtualenvs
 */
export function getDefaultPoetryVirtualenvsPath(): string | undefined {
    const cacheDir = getDefaultPoetryCacheDir();
    if (cacheDir) {
        return path.join(cacheDir, 'virtualenvs');
    }
    return undefined;
}

/**
 * Resolves the {cache-dir} placeholder in a Poetry virtualenvs path.
 * First tries to query Poetry's cache-dir config, then falls back to platform-specific default.
 * @param poetry Path to the poetry executable
 * @param virtualenvsPath The path possibly containing {cache-dir} placeholder
 * @returns The resolved path, or undefined if the placeholder cannot be resolved
 */
async function resolveVirtualenvsPath(poetry: string, virtualenvsPath: string): Promise<string | undefined> {
    if (!virtualenvsPath.includes('{cache-dir}')) {
        return virtualenvsPath;
    }

    // Try to get the actual cache-dir from Poetry
    try {
        const { stdout } = await execProcess(`"${poetry}" config cache-dir`);
        if (stdout) {
            const cacheDir = stdout.trim();
            if (cacheDir && path.isAbsolute(cacheDir)) {
                const resolved = virtualenvsPath.replace('{cache-dir}', cacheDir);
                return path.normalize(resolved);
            }
        }
    } catch (e) {
        traceError('Error getting Poetry cache-dir config', e);
    }

    // Fall back to platform-specific default cache dir
    const defaultCacheDir = getDefaultPoetryCacheDir();
    if (defaultCacheDir) {
        const resolved = virtualenvsPath.replace('{cache-dir}', defaultCacheDir);
        return path.normalize(resolved);
    }

    // Cannot resolve the placeholder - return undefined instead of unresolved path
    return undefined;
}

export async function getPoetryVersion(poetry: string): Promise<string | undefined> {
    try {
        const { stdout } = await execProcess(`"${poetry}" --version`);
        // Handle both formats:
        // Old: "Poetry version 1.5.1"
        // New: "Poetry (version 2.1.3)"
        traceInfo(`Poetry version output: ${stdout.trim()}`);
        const match = stdout.match(/Poetry (?:version |[\(\s]+version[\s\)]+)([0-9]+\.[0-9]+\.[0-9]+)/i);
        return match ? match[1] : undefined;
    } catch {
        return undefined;
    }
}
export async function nativeToPythonEnv(
    info: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    _poetry: string,
): Promise<PythonEnvironment | undefined> {
    if (!(info.prefix && info.executable && info.version)) {
        traceError(`Incomplete poetry environment info: ${JSON.stringify(info)}`);
        return undefined;
    }

    const sv = shortVersion(info.version);
    const name = info.name || info.displayName || path.basename(info.prefix);
    const displayName = info.displayName || `poetry (${sv})`;

    // Check if this is a global Poetry virtualenv by checking if it's in Poetry's virtualenvs directory
    // We use normalizePath() for case-insensitive path comparison on Windows
    const normalizedPrefix = normalizePath(info.prefix);

    // Determine if the environment is in Poetry's global virtualenvs directory
    let isGlobalPoetryEnv = false;

    // If POETRY_VIRTUALENVS_IN_PROJECT is set and env has a project, it's an in-project env
    if (!isPoetryVirtualenvsInProject() || !info.project) {
        const virtualenvsPath = poetryVirtualenvsPath; // Use the cached value if available
        if (virtualenvsPath) {
            const normalizedVirtualenvsPath = normalizePath(virtualenvsPath);
            isGlobalPoetryEnv = normalizedPrefix.startsWith(normalizedVirtualenvsPath);
        } else {
            // Fall back to checking the platform-specific default location if we haven't cached the path yet
            const defaultPath = getDefaultPoetryVirtualenvsPath();
            if (defaultPath) {
                const normalizedDefaultPath = normalizePath(defaultPath);
                isGlobalPoetryEnv = normalizedPrefix.startsWith(normalizedDefaultPath);

                // Try to get the actual path asynchronously for next time
                getPoetryVirtualenvsPath(_poetry).catch((e) => traceError('Error getting Poetry virtualenvs path', e));
            }
        }
    }

    // Get generic python environment info to access shell activation/deactivation commands following Poetry 2.0+ dropping the `shell` command
    const binDir = path.dirname(info.executable);
    const { shellActivation, shellDeactivation } = await getShellActivationCommands(binDir);

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
        group: isGlobalPoetryEnv ? POETRY_GLOBAL : undefined,
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

    await Promise.all(
        envs.map(async (e) => {
            if (poetry) {
                const environment = await nativeToPythonEnv(e, api, manager, poetry);
                if (environment) {
                    collection.push(environment);
                }
            }
        }),
    );

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
