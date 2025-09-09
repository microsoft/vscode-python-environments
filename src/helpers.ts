import { ExtensionContext, extensions, Uri, workspace } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from './api';
import { traceError, traceInfo, traceWarn } from './common/logging';
import { normalizePath } from './common/utils/pathUtils';
import { getConfiguration } from './common/workspace.apis';
import { getAutoActivationType } from './features/terminal/utils';
import { EnvironmentManagers, PythonProjectManager } from './internal.api';
import { NativeEnvInfo, NativePythonFinder } from './managers/common/nativePythonFinder';

/**
 * Collects relevant Python environment information for issue reporting
 */
export async function collectEnvironmentInfo(
    context: ExtensionContext,
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager,
): Promise<string> {
    const info: string[] = [];

    try {
        // Extension version
        const extensionVersion = context.extension?.packageJSON?.version || 'unknown';
        info.push(`Extension Version: ${extensionVersion}`);

        // Python extension version
        const pythonExtension = extensions.getExtension('ms-python.python');
        const pythonVersion = pythonExtension?.packageJSON?.version || 'not installed';
        info.push(`Python Extension Version: ${pythonVersion}`);

        // Environment managers
        const managers = envManagers.managers;
        info.push(`\nRegistered Environment Managers (${managers.length}):`);
        managers.forEach((manager) => {
            info.push(`  - ${manager.id} (${manager.displayName})`);
        });

        // Available environments
        const allEnvironments: PythonEnvironment[] = [];
        for (const manager of managers) {
            try {
                const envs = await manager.getEnvironments('all');
                allEnvironments.push(...envs);
            } catch (err) {
                info.push(`  Error getting environments from ${manager.id}: ${err}`);
            }
        }

        info.push(`\nTotal Available Environments: ${allEnvironments.length}`);
        if (allEnvironments.length > 0) {
            info.push('Environment Details:');
            allEnvironments.slice(0, 10).forEach((env, index) => {
                info.push(`  ${index + 1}. ${env.displayName} (${env.version}) - ${env.displayPath}`);
            });
            if (allEnvironments.length > 10) {
                info.push(`  ... and ${allEnvironments.length - 10} more environments`);
            }
        }

        // Python projects
        const projects = projectManager.getProjects();
        info.push(`\nPython Projects (${projects.length}):`);
        for (let index = 0; index < projects.length; index++) {
            const project = projects[index];
            info.push(`  ${index + 1}. ${project.uri.fsPath}`);
            try {
                const env = await envManagers.getEnvironment(project.uri);
                if (env) {
                    info.push(`     Environment: ${env.displayName}`);
                }
            } catch (err) {
                info.push(`     Error getting environment: ${err}`);
            }
        }

        // Current settings (non-sensitive)
        const config = workspace.getConfiguration('python-envs');
        const pyConfig = workspace.getConfiguration('python');
        info.push('\nExtension Settings:');
        info.push(`  Default Environment Manager: ${config.get('defaultEnvManager')}`);
        info.push(`  Default Package Manager: ${config.get('defaultPackageManager')}`);
        const pyenvAct = config.get('terminal.autoActivationType', undefined);
        const pythonAct = pyConfig.get('terminal.activateEnvironment', undefined);
        info.push(
            `Auto-activation is "${getAutoActivationType()}". Activation based on first 'py-env.terminal.autoActivationType' setting which is '${pyenvAct}' and 'python.terminal.activateEnvironment' if the first is undefined which is '${pythonAct}'.\n`,
        );
    } catch (err) {
        info.push(`\nError collecting environment information: ${err}`);
    }

    return info.join('\n');
}

/**
 * Logs the values of defaultPackageManager and defaultEnvManager at all configuration levels (workspace folder, workspace, user/global, default).
 */
export function getEnvManagerAndPackageManagerConfigLevels() {
    const config = getConfiguration('python-envs');
    const envManagerInspect = config.inspect<string>('defaultEnvManager');
    const pkgManagerInspect = config.inspect<string>('defaultPackageManager');

    return {
        section: 'Python Envs Configuration Levels',
        defaultEnvManager: {
            workspaceFolderValue: envManagerInspect?.workspaceFolderValue ?? 'undefined',
            workspaceValue: envManagerInspect?.workspaceValue ?? 'undefined',
            globalValue: envManagerInspect?.globalValue ?? 'undefined',
            defaultValue: envManagerInspect?.defaultValue ?? 'undefined',
        },
        defaultPackageManager: {
            workspaceFolderValue: pkgManagerInspect?.workspaceFolderValue ?? 'undefined',
            workspaceValue: pkgManagerInspect?.workspaceValue ?? 'undefined',
            globalValue: pkgManagerInspect?.globalValue ?? 'undefined',
            defaultValue: pkgManagerInspect?.defaultValue ?? 'undefined',
        },
    };
}

/**
 * Sets the default Python interpreter for the workspace if the user has not explicitly set 'defaultEnvManager' or it is set to venv.
 * @param nativeFinder -  used to resolve interpreter paths.
 * @param envManagers - contains all registered managers.
 * @param api - The PythonEnvironmentApi for environment resolution and setting.
 */
export async function resolveDefaultInterpreter(
    nativeFinder: NativePythonFinder,
    envManagers: EnvironmentManagers,
    api: PythonEnvironmentApi,
) {
    const defaultInterpreterPath = getConfiguration('python').get<string>('defaultInterpreterPath');

    if (defaultInterpreterPath) {
        const config = getConfiguration('python-envs');
        const inspect = config.inspect<string>('defaultEnvManager');
        const userDefinedDefaultManager =
            inspect?.workspaceFolderValue !== undefined ||
            inspect?.workspaceValue !== undefined ||
            inspect?.globalValue !== undefined;
        if (!userDefinedDefaultManager) {
            try {
                const resolved: NativeEnvInfo = await nativeFinder.resolve(defaultInterpreterPath);
                if (resolved && resolved.executable) {
                    if (normalizePath(resolved.executable) === normalizePath(defaultInterpreterPath)) {
                        // no action required, the path is already correct
                        return;
                    }
                    const resolvedEnv = await api.resolveEnvironment(Uri.file(resolved.executable));
                    traceInfo(`[resolveDefaultInterpreter] API resolved environment: ${JSON.stringify(resolvedEnv)}`);

                    let findEnvManager = envManagers.managers.find((m) => m.id === resolvedEnv?.envId.managerId);
                    if (!findEnvManager) {
                        findEnvManager = envManagers.managers.find((m) => m.id === 'ms-python.python:system');
                    }
                    if (resolvedEnv) {
                        const newEnv: PythonEnvironment = {
                            envId: {
                                id: resolvedEnv?.envId.id,
                                managerId: resolvedEnv?.envId.managerId ?? '',
                            },
                            name: 'defaultInterpreterPath: ' + (resolved.version ?? ''),
                            displayName: 'defaultInterpreterPath: ' + (resolved.version ?? ''),
                            version: resolved.version ?? '',
                            displayPath: defaultInterpreterPath ?? '',
                            environmentPath: defaultInterpreterPath ? Uri.file(defaultInterpreterPath) : Uri.file(''),
                            sysPrefix: resolved.arch ?? '',
                            execInfo: {
                                run: {
                                    executable: defaultInterpreterPath ?? '',
                                },
                            },
                        };
                        if (workspace.workspaceFolders?.[0] && findEnvManager) {
                            traceInfo(
                                `[resolveDefaultInterpreter] Setting environment for workspace: ${workspace.workspaceFolders[0].uri.fsPath}`,
                            );
                            await api.setEnvironment(workspace.workspaceFolders[0].uri, newEnv);
                        }
                    }
                } else {
                    traceWarn(
                        `[resolveDefaultInterpreter] NativeFinder did not resolve an executable for path: ${defaultInterpreterPath}`,
                    );
                }
            } catch (err) {
                traceError(`[resolveDefaultInterpreter] Error resolving default interpreter: ${err}`);
            }
        }
    }
}
