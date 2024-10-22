import * as path from 'path';
import {
    ConfigurationScope,
    ConfigurationTarget,
    Uri,
    workspace,
    WorkspaceConfiguration,
    WorkspaceFolder,
} from 'vscode';
import { PythonProjectManager, PythonProjectSettings } from '../../internal.api';
import { traceError, traceInfo } from '../../common/logging';
import { PythonProject } from '../../api';
import { DEFAULT_ENV_MANAGER_ID, DEFAULT_PACKAGE_MANAGER_ID } from '../../common/constants';

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

export function getDefaultEnvManagerSetting(wm: PythonProjectManager, scope?: Uri): string {
    const config = workspace.getConfiguration('python-envs', scope);
    const settings = getSettings(wm, config, scope);
    if (settings && settings.envManager.length > 0) {
        return settings.envManager;
    }

    const defaultManager = config.get<string>('defaultEnvManager');
    if (defaultManager === undefined || defaultManager === null || defaultManager === '') {
        traceError('No default environment manager set. Check setting python-envs.defaultEnvManager');
        traceInfo(`Using system default package manager: ${DEFAULT_ENV_MANAGER_ID}`);
        return DEFAULT_ENV_MANAGER_ID;
    }
    return defaultManager;
}

export function getDefaultPkgManagerSetting(
    wm: PythonProjectManager,
    scope?: ConfigurationScope | null,
    defaultId?: string,
): string {
    const config = workspace.getConfiguration('python-envs', scope);

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

export async function setEnvironmentManager(context: Uri, managerId: string, wm: PythonProjectManager): Promise<void> {
    const pw = wm.get(context);
    const w = workspace.getWorkspaceFolder(context);
    if (pw && w) {
        const config = workspace.getConfiguration('python-envs', pw.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        const pwPath = path.normalize(pw.uri.fsPath);
        const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
        if (index >= 0) {
            overrides[index].envManager = managerId;
            await config.update('pythonProjects', overrides, ConfigurationTarget.Workspace);
        } else if (config.get('defaultEnvManager') !== managerId) {
            await config.update('defaultEnvManager', managerId, ConfigurationTarget.Workspace);
        }
    } else {
        const config = workspace.getConfiguration('python-envs', undefined);
        if (config.get('defaultEnvManager') !== managerId) {
            await config.update('defaultEnvManager', managerId, ConfigurationTarget.Global);
        }
    }
}

export async function setPackageManager(context: Uri, managerId: string, wm: PythonProjectManager): Promise<void> {
    const pw = wm.get(context);
    const w = workspace.getWorkspaceFolder(context);
    if (pw && w) {
        const config = workspace.getConfiguration('python-envs', pw.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        const pwPath = path.normalize(pw.uri.fsPath);
        const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
        if (index >= 0) {
            overrides[index].packageManager = managerId;
            await config.update('pythonProjects', overrides, ConfigurationTarget.Workspace);
        } else if (config.get('defaultPackageManager') !== managerId) {
            await config.update('defaultPackageManager', managerId, ConfigurationTarget.Workspace);
        }
    } else {
        const config = workspace.getConfiguration('python-envs', undefined);
        if (config.get('defaultPackageManager') !== managerId) {
            await config.update('defaultPackageManager', managerId, ConfigurationTarget.Global);
        }
    }
}

export interface EditSettings {
    project: PythonProject;
    envManager?: string;
    packageManager?: string;
}

export async function addPythonProjectSetting(edits: EditSettings[]): Promise<void> {
    const noWorkspace: EditSettings[] = [];
    const workspaces = new Map<WorkspaceFolder, EditSettings[]>();
    const globalConfig = workspace.getConfiguration('python-envs', undefined);
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

    const promises: Thenable<void>[] = [];
    workspaces.forEach((es, w) => {
        const config = workspace.getConfiguration('python-envs', w.uri);
        const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
        es.forEach((e) => {
            const pwPath = path.normalize(e.project.uri.fsPath);
            const index = overrides.findIndex((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
            if (index >= 0) {
                overrides[index].envManager = e.envManager ?? envManager;
                overrides[index].packageManager = e.packageManager ?? pkgManager;
            } else {
                overrides.push({
                    path: path.relative(w.uri.fsPath, pwPath).replace(/\\/g, '/'),
                    envManager,
                    packageManager: pkgManager,
                });
            }
        });
        promises.push(config.update('pythonProjects', overrides, ConfigurationTarget.Workspace));
    });
    await Promise.all(promises);
}

export async function removePythonProjectSetting(edits: EditSettings[]): Promise<void> {
    const noWorkspace: EditSettings[] = [];
    const workspaces = new Map<WorkspaceFolder, EditSettings[]>();
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
        const config = workspace.getConfiguration('python-envs', w.uri);
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
