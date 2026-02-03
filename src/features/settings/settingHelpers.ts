import * as path from 'path';
import {
    ConfigurationScope,
    ConfigurationTarget,
    Uri,
    workspace,
    WorkspaceConfiguration,
    WorkspaceFolder,
} from 'vscode';
import { PythonProject } from '../../api';
import { DEFAULT_ENV_MANAGER_ID, DEFAULT_PACKAGE_MANAGER_ID } from '../../common/constants';
import { traceError, traceInfo, traceWarn } from '../../common/logging';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonProjectManager, PythonProjectSettings } from '../../internal.api';

function getSettings(
    wm: PythonProjectManager,
    config: WorkspaceConfiguration,
    scope?: ConfigurationScope | null,
): PythonProjectSettings | undefined {
    const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);

    if (overrides.length > 0 && scope instanceof Uri) {
        const pw = wm.get(scope);
        const w = workspace.getWorkspaceFolder(scope);
        if (pw && w) {
            const pwPath = path.normalize(pw.uri.fsPath);
            return overrides.find((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
        }
    }
    return undefined;
}

let DEFAULT_ENV_MANAGER_BROKEN = false;
let hasShownDefaultEnvManagerBrokenWarn = false;

export function setDefaultEnvManagerBroken(broken: boolean) {
    DEFAULT_ENV_MANAGER_BROKEN = broken;
}
export function isDefaultEnvManagerBroken(): boolean {
    return DEFAULT_ENV_MANAGER_BROKEN;
}

export function getDefaultEnvManagerSetting(wm: PythonProjectManager, scope?: Uri): string {
    const config = workspaceApis.getConfiguration('python-envs', scope);
    const settings = getSettings(wm, config, scope);
    if (settings && settings.envManager.length > 0) {
        return settings.envManager;
    }
    // Only show the warning once per session
    if (isDefaultEnvManagerBroken()) {
        if (!hasShownDefaultEnvManagerBrokenWarn) {
            traceWarn(`Default environment manager is broken, using system default: ${DEFAULT_ENV_MANAGER_ID}`);
            hasShownDefaultEnvManagerBrokenWarn = true;
        }
        return DEFAULT_ENV_MANAGER_ID;
    }
    const defaultManager = config.get<string>('defaultEnvManager');
    if (defaultManager === undefined || defaultManager === null || defaultManager === '') {
        traceError('No default environment manager set. Check setting python-envs.defaultEnvManager');
        traceWarn(`Using system default package manager: ${DEFAULT_ENV_MANAGER_ID}`);
        return DEFAULT_ENV_MANAGER_ID;
    }
    return defaultManager;
}

export function getDefaultPkgManagerSetting(
    wm: PythonProjectManager,
    scope?: ConfigurationScope | null,
    defaultId?: string,
): string {
    const config = workspaceApis.getConfiguration('python-envs', scope);

    const settings = getSettings(wm, config, scope);
    if (settings && settings.packageManager.length > 0) {
        return settings.packageManager;
    }

    const defaultManager = config.get<string>('defaultPackageManager');
    if (defaultManager === undefined || defaultManager === null || defaultManager === '') {
        if (defaultId) {
            return defaultId;
        }
        traceError('No default environment manager set. Check setting python-envs.defaultPackageManager');
        traceInfo(`Using system default package manager: ${DEFAULT_PACKAGE_MANAGER_ID}`);
        return DEFAULT_PACKAGE_MANAGER_ID;
    }
    return defaultManager;
}

export interface EditAllManagerSettings {
    // undefined means global
    project?: PythonProject;
    envManager: string;
    packageManager: string;
}
interface EditAllManagerSettingsInternal {
    project: PythonProject;
    envManager: string;
    packageManager: string;
}
export async function setAllManagerSettings(edits: EditAllManagerSettings[]): Promise<void> {
    const noWorkspace: EditAllManagerSettingsInternal[] = [];
    const workspaces = new Map<WorkspaceFolder, EditAllManagerSettingsInternal[]>();
    edits
        .filter((e) => !!e.project)
        .map((e) => e as EditAllManagerSettingsInternal)
        .forEach((e) => {
            const w = workspace.getWorkspaceFolder(e.project.uri);
            if (w) {
                workspaces.set(w, [
                    ...(workspaces.get(w) || []),
                    { project: e.project, envManager: e.envManager, packageManager: e.packageManager },
                ]);
            } else {
                noWorkspace.push({ project: e.project, envManager: e.envManager, packageManager: e.packageManager });
            }
        });

    noWorkspace.forEach((e) => {
        if (e.project) {
            traceInfo(`Unable to find workspace for ${e.project.uri.fsPath}, will use global settings for this.`);
        }
    });

    const workspaceFile = workspaceApis.getWorkspaceFile();
    const promises: Thenable<void>[] = [];

    workspaces.forEach((es, w) => {
        const config = workspaceApis.getConfiguration('python-envs', w);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        const projectsInspect = config.inspect<PythonProjectSettings[]>('pythonProjects');
        const existingProjectsSetting =
            projectsInspect?.workspaceFolderValue ?? projectsInspect?.workspaceValue ?? undefined;
        const originalOverridesLength = overrides.length;

        es.forEach((e) => {
            const pwPath = path.normalize(e.project.uri.fsPath);
            const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
            if (index >= 0) {
                overrides[index].envManager = e.envManager;
                overrides[index].packageManager = e.packageManager;
            } else if (workspaceFile) {
                overrides.push({
                    path: path.relative(w.uri.fsPath, pwPath).replace(/\\/g, '/'),
                    envManager: e.envManager,
                    packageManager: e.packageManager,
                });
            } else {
                // Only write settings if:
                // 1. There's already an explicit setting (we're updating it), OR
                // 2. The new value is not the implicit fallback (system manager is the fallback)
                const isSystemManager = e.envManager === 'ms-python.python:system';
                const envManagerInspect = config.inspect<string>('defaultEnvManager');
                const hasExplicitEnvManager =
                    envManagerInspect?.workspaceFolderValue !== undefined ||
                    envManagerInspect?.workspaceValue !== undefined;

                // Write if changing an existing setting, OR if setting to non-system manager
                if ((hasExplicitEnvManager || !isSystemManager) && config.get('defaultEnvManager') !== e.envManager) {
                    promises.push(config.update('defaultEnvManager', e.envManager, ConfigurationTarget.Workspace));
                }

                const pkgManagerInspect = config.inspect<string>('defaultPackageManager');
                const hasExplicitPkgManager =
                    pkgManagerInspect?.workspaceFolderValue !== undefined ||
                    pkgManagerInspect?.workspaceValue !== undefined;
                // For package manager, write if there's an explicit setting OR if env manager is being written
                if (
                    (hasExplicitPkgManager || !isSystemManager) &&
                    config.get('defaultPackageManager') !== e.packageManager
                ) {
                    promises.push(
                        config.update('defaultPackageManager', e.packageManager, ConfigurationTarget.Workspace),
                    );
                }
            }
        });

        // Only write pythonProjects if:
        // 1. There was already an explicit setting  OR
        // 2. adding new project entries
        const shouldWriteProjects = existingProjectsSetting !== undefined || overrides.length > originalOverridesLength;
        if (shouldWriteProjects) {
            promises.push(
                config.update(
                    'pythonProjects',
                    overrides,
                    workspaceFile ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace,
                ),
            );
        }
    });

    const config = workspaceApis.getConfiguration('python-envs', undefined);
    edits
        .filter((e) => !e.project)
        .forEach((e) => {
            // Only write global settings if:
            // 1. There's already an explicit global setting (we're updating it), OR
            // 2. The new value is not the implicit fallback (system manager)
            const isSystemManager = e.envManager === 'ms-python.python:system';
            const envManagerInspect = config.inspect<string>('defaultEnvManager');
            const hasExplicitGlobalEnvManager = envManagerInspect?.globalValue !== undefined;

            if ((hasExplicitGlobalEnvManager || !isSystemManager) && config.get('defaultEnvManager') !== e.envManager) {
                promises.push(config.update('defaultEnvManager', e.envManager, ConfigurationTarget.Global));
            }

            const pkgManagerInspect = config.inspect<string>('defaultPackageManager');
            const hasExplicitGlobalPkgManager = pkgManagerInspect?.globalValue !== undefined;
            if (
                (hasExplicitGlobalPkgManager || !isSystemManager) &&
                config.get('defaultPackageManager') !== e.packageManager
            ) {
                promises.push(config.update('defaultPackageManager', e.packageManager, ConfigurationTarget.Global));
            }
        });

    await Promise.all(promises);
}

export interface EditEnvManagerSettings {
    // undefined means global
    project?: PythonProject;
    envManager: string;
}
interface EditEnvManagerSettingsInternal {
    project: PythonProject;
    envManager: string;
}
export async function setEnvironmentManager(edits: EditEnvManagerSettings[]): Promise<void> {
    const noWorkspace: EditEnvManagerSettingsInternal[] = [];
    const workspaces = new Map<WorkspaceFolder, EditEnvManagerSettingsInternal[]>();
    edits
        .filter((e) => !!e.project)
        .map((e) => e as EditEnvManagerSettingsInternal)
        .forEach((e) => {
            const w = workspace.getWorkspaceFolder(e.project.uri);
            if (w) {
                workspaces.set(w, [...(workspaces.get(w) || []), { project: e.project, envManager: e.envManager }]);
            } else {
                noWorkspace.push({ project: e.project, envManager: e.envManager });
            }
        });

    noWorkspace.forEach((e) => {
        if (e.project) {
            traceError(`Unable to find workspace for ${e.project.uri.fsPath}`);
        }
    });

    const promises: Thenable<void>[] = [];

    workspaces.forEach((es, w) => {
        const config = workspaceApis.getConfiguration('python-envs', w.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        const projectsInspect = config.inspect<PythonProjectSettings[]>('pythonProjects');
        const existingProjectsSetting = projectsInspect?.workspaceValue ?? undefined;
        const originalOverridesLength = overrides.length;
        let projectsModified = false;

        es.forEach((e) => {
            const pwPath = path.normalize(e.project.uri.fsPath);
            const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
            if (index >= 0) {
                overrides[index].envManager = e.envManager;
                projectsModified = true;
            } else {
                // Only write settings if updating existing OR setting non-system manager
                const isSystemManager = e.envManager === 'ms-python.python:system';
                const envManagerInspect = config.inspect<string>('defaultEnvManager');
                const hasExplicitEnvManager = envManagerInspect?.workspaceValue !== undefined;
                if ((hasExplicitEnvManager || !isSystemManager) && config.get('defaultEnvManager') !== e.envManager) {
                    promises.push(config.update('defaultEnvManager', e.envManager, ConfigurationTarget.Workspace));
                }
            }
        });

        // Only write pythonProjects if there was an explicit setting or we modified entries
        const shouldWriteProjects =
            existingProjectsSetting !== undefined || overrides.length > originalOverridesLength || projectsModified;
        if (shouldWriteProjects) {
            promises.push(config.update('pythonProjects', overrides, ConfigurationTarget.Workspace));
        }
    });

    const config = workspaceApis.getConfiguration('python-envs', undefined);
    edits
        .filter((e) => !e.project)
        .forEach((e) => {
            // Only write global settings if updating existing OR setting non-system manager
            const isSystemManager = e.envManager === 'ms-python.python:system';
            const envManagerInspect = config.inspect<string>('defaultEnvManager');
            const hasExplicitGlobalEnvManager = envManagerInspect?.globalValue !== undefined;
            if ((hasExplicitGlobalEnvManager || !isSystemManager) && config.get('defaultEnvManager') !== e.envManager) {
                promises.push(config.update('defaultEnvManager', e.envManager, ConfigurationTarget.Global));
            }
        });

    await Promise.all(promises);
}

export interface EditPackageManagerSettings {
    // undefined means global
    project?: PythonProject;
    packageManager: string;
}
interface EditPackageManagerSettingsInternal {
    project: PythonProject;
    packageManager: string;
}
export async function setPackageManager(edits: EditPackageManagerSettings[]): Promise<void> {
    const noWorkspace: EditPackageManagerSettingsInternal[] = [];
    const workspaces = new Map<WorkspaceFolder, EditPackageManagerSettingsInternal[]>();
    edits
        .filter((e) => !!e.project)
        .map((e) => e as EditPackageManagerSettingsInternal)
        .forEach((e) => {
            const w = workspace.getWorkspaceFolder(e.project.uri);
            if (w) {
                workspaces.set(w, [
                    ...(workspaces.get(w) || []),
                    { project: e.project, packageManager: e.packageManager },
                ]);
            } else {
                noWorkspace.push({ project: e.project, packageManager: e.packageManager });
            }
        });

    noWorkspace.forEach((e) => {
        if (e.project) {
            traceError(`Unable to find workspace for ${e.project.uri.fsPath}`);
        }
    });

    const promises: Thenable<void>[] = [];

    workspaces.forEach((es, w) => {
        const config = workspaceApis.getConfiguration('python-envs', w.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        const projectsInspect = config.inspect<PythonProjectSettings[]>('pythonProjects');
        const existingProjectsSetting = projectsInspect?.workspaceValue ?? undefined;
        const originalOverridesLength = overrides.length;
        let projectsModified = false;

        es.forEach((e) => {
            const pwPath = path.normalize(e.project.uri.fsPath);
            const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
            if (index >= 0) {
                overrides[index].packageManager = e.packageManager;
                projectsModified = true;
            } else {
                // Only write settings if updating existing OR setting non-default package manager
                const isPipManager = e.packageManager === 'ms-python.python:pip';
                const pkgManagerInspect = config.inspect<string>('defaultPackageManager');
                const hasExplicitPkgManager = pkgManagerInspect?.workspaceValue !== undefined;
                if (
                    (hasExplicitPkgManager || !isPipManager) &&
                    config.get('defaultPackageManager') !== e.packageManager
                ) {
                    promises.push(
                        config.update('defaultPackageManager', e.packageManager, ConfigurationTarget.Workspace),
                    );
                }
            }
        });

        // Only write pythonProjects if there was an explicit setting or we modified entries
        const shouldWriteProjects =
            existingProjectsSetting !== undefined || overrides.length > originalOverridesLength || projectsModified;
        if (shouldWriteProjects) {
            promises.push(config.update('pythonProjects', overrides, ConfigurationTarget.Workspace));
        }
    });

    const config = workspaceApis.getConfiguration('python-envs', undefined);
    edits
        .filter((e) => !e.project)
        .forEach((e) => {
            // Only write global settings if updating existing OR setting non-default package manager
            const isPipManager = e.packageManager === 'ms-python.python:pip';
            const pkgManagerInspect = config.inspect<string>('defaultPackageManager');
            const hasExplicitGlobalPkgManager = pkgManagerInspect?.globalValue !== undefined;
            if (
                (hasExplicitGlobalPkgManager || !isPipManager) &&
                config.get('defaultPackageManager') !== e.packageManager
            ) {
                promises.push(config.update('defaultPackageManager', e.packageManager, ConfigurationTarget.Global));
            }
        });

    await Promise.all(promises);
}

export interface EditProjectSettings {
    project: PythonProject;
    envManager?: string;
    packageManager?: string;
    workspace?: string;
}

export async function addPythonProjectSetting(edits: EditProjectSettings[]): Promise<void> {
    const noWorkspace: EditProjectSettings[] = [];
    const workspaces = new Map<WorkspaceFolder, EditProjectSettings[]>();
    const globalConfig = workspaceApis.getConfiguration('python-envs', undefined);
    const envManager = globalConfig.get<string>('defaultEnvManager', DEFAULT_ENV_MANAGER_ID);
    const pkgManager = globalConfig.get<string>('defaultPackageManager', DEFAULT_PACKAGE_MANAGER_ID);

    edits.forEach((e) => {
        const w = workspace.getWorkspaceFolder(e.project.uri);
        if (w) {
            workspaces.set(w, [...(workspaces.get(w) || []), e]);
        } else {
            noWorkspace.push(e);
        }
    });

    noWorkspace.forEach((e) => {
        traceError(`Unable to find workspace for ${e.project.uri.fsPath}`);
    });

    const isMultiroot = (workspaceApis.getWorkspaceFolders() ?? []).length > 1;

    const promises: Thenable<void>[] = [];
    workspaces.forEach((es, w) => {
        const config = workspaceApis.getConfiguration('python-envs', w.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        es.forEach((e) => {
            if (isMultiroot) {
            }
            const pwPath = path.normalize(e.project.uri.fsPath);
            const index = overrides.findIndex((s) => {
                if (s.workspace) {
                    // If the workspace is set, check workspace and path in existing overrides
                    return s.workspace === w.name && path.resolve(w.uri.fsPath, s.path) === pwPath;
                }
                return path.resolve(w.uri.fsPath, s.path) === pwPath;
            });
            if (index >= 0) {
                // Preserve existing manager settings if not explicitly provided
                overrides[index].envManager = e.envManager ?? overrides[index].envManager;
                overrides[index].packageManager = e.packageManager ?? overrides[index].packageManager;
            } else {
                overrides.push({
                    path: path.relative(w.uri.fsPath, pwPath).replace(/\\/g, '/'),
                    envManager,
                    packageManager: pkgManager,
                    workspace: isMultiroot ? w.name : undefined,
                });
            }
        });
        promises.push(config.update('pythonProjects', overrides, ConfigurationTarget.Workspace));
    });
    await Promise.all(promises);
}

export async function removePythonProjectSetting(edits: EditProjectSettings[]): Promise<void> {
    const noWorkspace: EditProjectSettings[] = [];
    const workspaces = new Map<WorkspaceFolder, EditProjectSettings[]>();
    edits.forEach((e) => {
        const w = workspace.getWorkspaceFolder(e.project.uri);
        if (w) {
            workspaces.set(w, [...(workspaces.get(w) || []), e]);
        } else {
            noWorkspace.push(e);
        }
    });

    noWorkspace.forEach((e) => {
        traceError(`Unable to find workspace for ${e.project.uri.fsPath}`);
    });

    const promises: Thenable<void>[] = [];
    workspaces.forEach((es, w) => {
        const config = workspaceApis.getConfiguration('python-envs', w.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        es.forEach((e) => {
            const pwPath = path.normalize(e.project.uri.fsPath);
            const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
            if (index >= 0) {
                overrides.splice(index, 1);
            }
        });
        if (overrides.length === 0) {
            promises.push(config.update('pythonProjects', undefined, ConfigurationTarget.Workspace));
        } else {
            promises.push(config.update('pythonProjects', overrides, ConfigurationTarget.Workspace));
        }
    });
    await Promise.all(promises);
}

/**
 * Updates the path of a project in pythonProjects settings when a folder is renamed/moved.
 * @param oldUri The original URI of the project folder
 * @param newUri The new URI of the project folder after rename/move
 */
export async function updatePythonProjectSettingPath(oldUri: Uri, newUri: Uri): Promise<void> {
    const workspaceFolders = workspaceApis.getWorkspaceFolders() ?? [];

    // Find the workspace folder that contains the old path
    let targetWorkspace: WorkspaceFolder | undefined;
    for (const w of workspaceFolders) {
        const oldPath = path.normalize(oldUri.fsPath);
        if (oldPath.startsWith(path.normalize(w.uri.fsPath))) {
            targetWorkspace = w;
            break;
        }
    }

    if (!targetWorkspace) {
        traceError(`Unable to find workspace for ${oldUri.fsPath}`);
        return;
    }

    const config = workspaceApis.getConfiguration('python-envs', targetWorkspace.uri);
    const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
    const oldNormalizedPath = path.normalize(oldUri.fsPath);

    const index = overrides.findIndex((s) => path.resolve(targetWorkspace!.uri.fsPath, s.path) === oldNormalizedPath);
    if (index >= 0) {
        // Update the path to the new location
        const newRelativePath = path.relative(targetWorkspace.uri.fsPath, newUri.fsPath).replace(/\\/g, '/');
        overrides[index].path = newRelativePath;
        await config.update('pythonProjects', overrides, ConfigurationTarget.Workspace);
        traceInfo(`Updated project path from ${oldUri.fsPath} to ${newUri.fsPath}`);
    }
}

/**
 * Gets user-configured setting for window-scoped settings.
 * Priority order: globalRemoteValue > globalLocalValue > globalValue
 * @param section - The configuration section (e.g., 'python-envs')
 * @param key - The configuration key (e.g., 'terminal.autoActivationType')
 * @returns The user-configured value or undefined if not set by user
 */
export function getSettingWindowScope<T>(section: string, key: string): T | undefined {
    const config = workspaceApis.getConfiguration(section);
    const inspect = config.inspect<T>(key);
    if (!inspect) {
        return undefined;
    }

    const inspectRecord = inspect as Record<string, unknown>;
    if ('globalRemoteValue' in inspect && inspectRecord.globalRemoteValue !== undefined) {
        return inspectRecord.globalRemoteValue as T;
    }
    if ('globalLocalValue' in inspect && inspectRecord.globalLocalValue !== undefined) {
        return inspectRecord.globalLocalValue as T;
    }
    if (inspect.globalValue !== undefined) {
        return inspect.globalValue;
    }
    return undefined;
}

/**
 * Gets user-configured setting for workspace-scoped settings.
 * Priority order: workspaceFolderValue > workspaceValue > globalValue
 * @param section - The configuration section (e.g., 'python')
 * @param key - The configuration key (e.g., 'pipenvPath')
 * @param scope - Optional URI scope for workspace folder-specific settings
 * @returns The user-configured value or undefined if not set by user
 */
export function getSettingWorkspaceScope<T>(section: string, key: string, scope?: Uri): T | undefined {
    const config = workspaceApis.getConfiguration(section, scope);
    const inspect = config.inspect<T>(key);
    if (!inspect) {
        return undefined;
    }

    if (inspect.workspaceFolderValue !== undefined) {
        return inspect.workspaceFolderValue;
    }
    if (inspect.workspaceValue !== undefined) {
        return inspect.workspaceValue;
    }
    if (inspect.globalValue !== undefined) {
        return inspect.globalValue;
    }
    return undefined;
}

/**
 * Gets user-configured setting for user-scoped settings.
 * Only checks globalValue (ignores defaultValue).
 * @param section - The configuration section (e.g., 'python')
 * @param key - The configuration key (e.g., 'pipenvPath')
 * @returns The user-configured value or undefined if not set by user
 */
export function getSettingUserScope<T>(section: string, key: string): T | undefined {
    const config = workspaceApis.getConfiguration(section);
    const inspect = config.inspect<T>(key);
    if (!inspect) {
        return undefined;
    }

    if (inspect.globalValue !== undefined) {
        return inspect.globalValue;
    }
    return undefined;
}
