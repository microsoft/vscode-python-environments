import { getDefaultEnvManagerSetting, getDefaultPkgManagerSetting } from '../../features/settings/settingHelpers';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { getWorkspaceFolders } from '../workspace.apis';
import { EventNames } from './constants';
import { sendTelemetryEvent } from './sender';

export function sendManagerSelectionTelemetry(pm: PythonProjectManager) {
    const ems: Set<string> = new Set();
    const ps: Set<string> = new Set();
    pm.getProjects().forEach((project) => {
        const m = getDefaultEnvManagerSetting(pm, project.uri);
        if (m) {
            ems.add(m);
        }

        const p = getDefaultPkgManagerSetting(pm, project.uri);
        if (p) {
            ps.add(p);
        }
    });

    ems.forEach((em) => {
        sendTelemetryEvent(EventNames.ENVIRONMENT_MANAGER_SELECTED, undefined, { managerId: em });
    });

    ps.forEach((pkg) => {
        sendTelemetryEvent(EventNames.PACKAGE_MANAGER_SELECTED, undefined, { managerId: pkg });
    });
}

export async function sendProjectStructureTelemetry(
    pm: PythonProjectManager,
    envManagers: EnvironmentManagers,
): Promise<void> {
    const projects = pm.getProjects();

    // 1. Total project count
    const totalProjectCount = projects.length;

    // 2. Unique interpreter count
    const interpreterPaths = new Set<string>();
    for (const project of projects) {
        try {
            const env = await envManagers.getEnvironment(project.uri);
            if (env?.environmentPath) {
                interpreterPaths.add(env.environmentPath.fsPath);
            }
        } catch {
            // Ignore errors when getting environment for a project
        }
    }
    const uniqueInterpreterCount = interpreterPaths.size;

    // 3. Projects under workspace root count
    const workspaceFolders = getWorkspaceFolders() ?? [];
    let projectUnderRoot = 0;
    for (const project of projects) {
        for (const wsFolder of workspaceFolders) {
            const workspacePath = wsFolder.uri.fsPath;
            const projectPath = project.uri.fsPath;
            
            // Check if project is a subdirectory of workspace folder:
            // - Path must start with workspace path
            // - Path must not be equal to workspace path
            // - The character after workspace path must be a path separator
            if (
                projectPath !== workspacePath &&
                projectPath.startsWith(workspacePath) &&
                (projectPath[workspacePath.length] === '/' || projectPath[workspacePath.length] === '\\')
            ) {
                projectUnderRoot++;
                break; // Count each project only once even if under multiple workspace folders
            }
        }
    }

    sendTelemetryEvent(EventNames.PROJECT_STRUCTURE, undefined, {
        totalProjectCount,
        uniqueInterpreterCount,
        projectUnderRoot,
    });
}
