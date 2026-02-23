import { getDefaultEnvManagerSetting, getDefaultPkgManagerSetting } from '../../features/settings/settingHelpers';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { getWorkspaceFolders } from '../workspace.apis';
import { EventNames } from './constants';
import { sendTelemetryEvent } from './sender';

/**
 * Extracts the base tool name from a manager ID.
 * Example: 'ms-python.python:venv' -> 'venv'
 * Example: 'ms-python.python:conda' -> 'conda'
 */
function extractToolName(managerId: string): string {
    // Manager IDs follow the pattern 'extensionId:toolName'
    const parts = managerId.split(':');
    return parts.length > 1 ? parts[1].toLowerCase() : managerId.toLowerCase();
}

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

/**
 * Sends telemetry about which environment tools are actively used across all projects.
 * This tracks ACTUAL USAGE (which environments are set for projects), not just what's installed.
 *
 * Fires one event per tool that has at least one project using it.
 * This allows simple deduplication: dcount(machineId) by toolName gives unique users per tool.
 *
 * Called once at extension activation to understand user's environment tool usage patterns.
 */
export async function sendEnvironmentToolUsageTelemetry(
    pm: PythonProjectManager,
    envManagers: EnvironmentManagers,
): Promise<void> {
    const projects = pm.getProjects();

    // Track which tools are used (Set ensures uniqueness)
    const toolsUsed = new Set<string>();

    // Check which environment manager is used for each project
    for (const project of projects) {
        try {
            const env = await envManagers.getEnvironment(project.uri);
            if (env?.envId?.managerId) {
                const toolName = extractToolName(env.envId.managerId);

                // Check if this is a UV environment (UV uses venv manager but has 'uv' in description)
                const isUv = env.description?.toLowerCase().includes('uv') ?? false;

                // Determine the tool name
                if (isUv) {
                    toolsUsed.add('uv');
                } else {
                    // Normalize 'global' to 'system' for consistency
                    const normalizedTool = toolName === 'global' ? 'system' : toolName;
                    toolsUsed.add(normalizedTool);
                }
            }
        } catch {
            // Ignore errors when getting environment for a project
        }
    }

    // Fire one event per tool used
    toolsUsed.forEach((tool) => {
        sendTelemetryEvent(EventNames.ENVIRONMENT_TOOL_USAGE, undefined, {
            toolName: tool,
        });
    });
}
