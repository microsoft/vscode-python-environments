// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { commands, ConfigurationChangeEvent, Disposable, l10n, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../api';
import { SYSTEM_MANAGER_ID, VENV_MANAGER_ID } from '../common/constants';
import { traceError, traceInfo, traceVerbose, traceWarn } from '../common/logging';
import { resolveVariables } from '../common/utils/internalVariables';
import { showWarningMessage } from '../common/window.apis';
import {
    getConfiguration,
    getWorkspaceFolder,
    getWorkspaceFolders,
    onDidChangeConfiguration,
} from '../common/workspace.apis';
import { getUserConfiguredSetting } from '../helpers';
import {
    EnvironmentManagers,
    InternalEnvironmentManager,
    PythonProjectManager,
    PythonProjectSettings,
} from '../internal.api';
import { NativeEnvInfo, NativePythonFinder } from '../managers/common/nativePythonFinder';

/**
 * Result from the priority chain resolution.
 */
export interface PriorityChainResult {
    /** The environment manager to use */
    manager: InternalEnvironmentManager;
    /** Optional specific environment - if undefined, let the manager decide via get() */
    environment?: PythonEnvironment;
    /** Which priority level matched */
    source: 'pythonProjects' | 'defaultEnvManager' | 'defaultInterpreterPath' | 'autoDiscovery';
}

/**
 * Error information when a user-configured setting could not be applied.
 */
export interface SettingResolutionError {
    /** The setting that failed */
    setting: 'pythonProjects' | 'defaultEnvManager' | 'defaultInterpreterPath';
    /** The configured value */
    configuredValue: string;
    /** Reason for failure */
    reason: string;
}

/**
 * Core priority chain logic shared between workspace folder and global resolution.
 *
 * @param scope - The workspace folder URI (for workspace scope) or undefined (for global scope)
 * @param envManagers - The environment managers registry
 * @param projectManager - The project manager for pythonProjects[] lookups (only used for workspace scope)
 * @param nativeFinder - Native Python finder for path resolution
 * @param api - The Python environment API
 * @returns The resolved PriorityChainResult and any errors encountered
 */
async function resolvePriorityChainCore(
    scope: Uri | undefined,
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager | undefined,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
): Promise<{ result: PriorityChainResult; errors: SettingResolutionError[] }> {
    const errors: SettingResolutionError[] = [];
    const logPrefix = scope ? `[priorityChain] ${scope.fsPath}` : '[priorityChain:global]';

    // PRIORITY 1: Check pythonProjects[] for this workspace path (workspace scope only)
    if (scope && projectManager) {
        const projectManagerId = getProjectSpecificEnvManager(projectManager, scope);
        if (projectManagerId) {
            const manager = envManagers.getEnvironmentManager(projectManagerId);
            if (manager) {
                traceVerbose(`${logPrefix} Priority 1: Using pythonProjects[] manager: ${projectManagerId}`);
                return { result: { manager, source: 'pythonProjects' }, errors };
            }
            const error: SettingResolutionError = {
                setting: 'pythonProjects',
                configuredValue: projectManagerId,
                reason: `Environment manager '${projectManagerId}' is not registered`,
            };
            errors.push(error);
            traceWarn(`${logPrefix} pythonProjects[] manager '${projectManagerId}' not found, trying next priority`);
        }
    }

    // PRIORITY 2: User-configured defaultEnvManager (skip if only fallback)
    const userConfiguredManager = getUserConfiguredSetting<string>('python-envs', 'defaultEnvManager', scope);
    if (userConfiguredManager) {
        const manager = envManagers.getEnvironmentManager(userConfiguredManager);
        if (manager) {
            traceVerbose(`${logPrefix} Priority 2: Using user-configured defaultEnvManager: ${userConfiguredManager}`);
            return { result: { manager, source: 'defaultEnvManager' }, errors };
        }
        const error: SettingResolutionError = {
            setting: 'defaultEnvManager',
            configuredValue: userConfiguredManager,
            reason: `Environment manager '${userConfiguredManager}' is not registered`,
        };
        errors.push(error);
        traceWarn(`${logPrefix} defaultEnvManager '${userConfiguredManager}' not found, trying next priority`);
    }

    // PRIORITY 3: User-configured python.defaultInterpreterPath
    const userInterpreterPath = getUserConfiguredSetting<string>('python', 'defaultInterpreterPath', scope);
    if (userInterpreterPath) {
        const expandedInterpreterPath = resolveVariables(userInterpreterPath, scope);
        const resolved = await tryResolveInterpreterPath(nativeFinder, api, expandedInterpreterPath, envManagers);
        if (resolved) {
            traceVerbose(`${logPrefix} Priority 3: Using defaultInterpreterPath: ${userInterpreterPath}`);
            return { result: resolved, errors };
        }
        const error: SettingResolutionError = {
            setting: 'defaultInterpreterPath',
            configuredValue: userInterpreterPath,
            reason: `Could not resolve interpreter path '${userInterpreterPath}'`,
        };
        errors.push(error);
        traceWarn(
            `${logPrefix} defaultInterpreterPath '${userInterpreterPath}' unresolvable, falling back to auto-discovery`,
        );
    }

    // PRIORITY 4: Auto-discovery (no user-configured settings matched)
    const autoDiscoverResult = await autoDiscoverEnvironment(scope, envManagers);
    return { result: autoDiscoverResult, errors };
}

/**
 * Determine the environment for a workspace folder by walking the priority chain:
 *
 *   PRIORITY 1: pythonProjects[] entry for this path
 *   PRIORITY 2: User-configured defaultEnvManager (not fallback)
 *   PRIORITY 3: User-configured python.defaultInterpreterPath
 *   PRIORITY 4: Auto-discovery (local venv → global Python)
 *
 * Returns the manager (and optionally specific environment) without persisting to settings.
 *
 * @param scope - The workspace folder URI to resolve
 * @param envManagers - The environment managers registry
 * @param projectManager - The project manager for pythonProjects[] lookups
 * @param nativeFinder - Native Python finder for path resolution
 * @param api - The Python environment API
 */
export async function resolveEnvironmentByPriority(
    scope: Uri,
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
): Promise<PriorityChainResult> {
    const { result } = await resolvePriorityChainCore(scope, envManagers, projectManager, nativeFinder, api);
    return result;
}

/**
 * Determine the environment for global scope (no workspace folder) by walking the priority chain:
 *
 *   PRIORITY 1: (Skipped - pythonProjects[] doesn't apply to global scope)
 *   PRIORITY 2: User-configured defaultEnvManager (not fallback)
 *   PRIORITY 3: User-configured python.defaultInterpreterPath
 *   PRIORITY 4: Auto-discovery (system Python)
 *
 * Returns the manager (and optionally specific environment) without persisting to settings.
 *
 * @param envManagers - The environment managers registry
 * @param nativeFinder - Native Python finder for path resolution
 * @param api - The Python environment API
 */
export async function resolveGlobalEnvironmentByPriority(
    envManagers: EnvironmentManagers,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
): Promise<PriorityChainResult> {
    const { result } = await resolvePriorityChainCore(undefined, envManagers, undefined, nativeFinder, api);
    return result;
}

/**
 * Auto-discovery for any scope: try local venv first (if scope provided), then fall back to system manager.
 */
async function autoDiscoverEnvironment(
    scope: Uri | undefined,
    envManagers: EnvironmentManagers,
): Promise<PriorityChainResult> {
    // Try venv manager first for local environments (workspace scope only)
    if (scope) {
        const venvManager = envManagers.getEnvironmentManager(VENV_MANAGER_ID);
        if (venvManager) {
            try {
                const localEnv = await venvManager.get(scope);
                if (localEnv) {
                    return { manager: venvManager, environment: localEnv, source: 'autoDiscovery' };
                }
            } catch (err) {
                traceError(`[autoDiscover] Failed to check venv manager: ${err}`);
            }
        }
    }

    // Fall back to system manager
    const systemManager = envManagers.getEnvironmentManager(SYSTEM_MANAGER_ID);
    if (systemManager) {
        return { manager: systemManager, source: 'autoDiscovery' };
    }

    // Last resort: use any available manager
    const anyManager = envManagers.managers[0];
    if (anyManager) {
        traceWarn(`[autoDiscover] No venv or system manager available, using fallback manager: ${anyManager.id}`);
        return { manager: anyManager, source: 'autoDiscovery' };
    }

    // This should never happen if managers are registered properly
    throw new Error('No environment managers available');
}

/**
 * Called once at extension activation. Runs priority chain for all workspace folders
 * AND the global scope, and caches results WITHOUT writing to settings.json.
 *
 * This ensures users see an interpreter immediately while respecting:
 * - Existing project-specific settings (pythonProjects[])
 * - User's defaultEnvManager preference
 * - Legacy defaultInterpreterPath migration
 * - Auto-discovered local environments
 *
 * If user-configured settings cannot be applied, shows a warning notification
 * with an option to open settings.
 *
 * @param envManagers - The environment managers registry
 * @param projectManager - The project manager
 * @param nativeFinder - Native Python finder for path resolution
 * @param api - The Python environment API
 */
export async function applyInitialEnvironmentSelection(
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
): Promise<void> {
    const folders = getWorkspaceFolders() ?? [];
    traceInfo(
        `[interpreterSelection] Applying initial environment selection for ${folders.length} workspace folder(s)`,
    );

    const allErrors: SettingResolutionError[] = [];

    for (const folder of folders) {
        try {
            const { result, errors } = await resolvePriorityChainCore(
                folder.uri,
                envManagers,
                projectManager,
                nativeFinder,
                api,
            );
            allErrors.push(...errors);

            // Get the specific environment if not already resolved
            const env = result.environment ?? (await result.manager.get(folder.uri));

            // Cache only — NO settings.json write (shouldPersistSettings = false)
            await envManagers.setEnvironment(folder.uri, env, false);

            traceInfo(
                `[interpreterSelection] ${folder.name}: ${env?.displayName ?? 'none'} (source: ${result.source})`,
            );
        } catch (err) {
            traceError(`[interpreterSelection] Failed to set environment for ${folder.uri.fsPath}: ${err}`);
        }
    }

    // Also apply initial selection for global scope (no workspace folder)
    // This ensures defaultInterpreterPath is respected even without a workspace
    try {
        const { result, errors } = await resolvePriorityChainCore(undefined, envManagers, undefined, nativeFinder, api);
        allErrors.push(...errors);

        // Get the specific environment if not already resolved
        const env = result.environment ?? (await result.manager.get(undefined));

        // Cache only — NO settings.json write (shouldPersistSettings = false)
        await envManagers.setEnvironments('global', env, false);

        traceInfo(`[interpreterSelection] global: ${env?.displayName ?? 'none'} (source: ${result.source})`);
    } catch (err) {
        traceError(`[interpreterSelection] Failed to set global environment: ${err}`);
    }

    // Notify user if any settings could not be applied
    if (allErrors.length > 0) {
        await notifyUserOfSettingErrors(allErrors);
    }
}

/**
 * Notify the user when their configured settings could not be applied.
 * Shows a warning message with an option to open settings.
 */
async function notifyUserOfSettingErrors(errors: SettingResolutionError[]): Promise<void> {
    // Group errors by setting type to avoid spamming the user
    const uniqueSettings = [...new Set(errors.map((e) => e.setting))];

    for (const setting of uniqueSettings) {
        const settingErrors = errors.filter((e) => e.setting === setting);
        const firstError = settingErrors[0];

        let message: string;
        let settingKey: string;

        switch (setting) {
            case 'pythonProjects':
                message = l10n.t(
                    "Python project setting for environment manager '{0}' could not be applied: {1}",
                    firstError.configuredValue,
                    firstError.reason,
                );
                settingKey = 'python-envs.pythonProjects';
                break;
            case 'defaultEnvManager':
                message = l10n.t(
                    "Default environment manager '{0}' could not be applied: {1}",
                    firstError.configuredValue,
                    firstError.reason,
                );
                settingKey = 'python-envs.defaultEnvManager';
                break;
            case 'defaultInterpreterPath':
                message = l10n.t(
                    "Default interpreter path '{0}' could not be resolved: {1}",
                    firstError.configuredValue,
                    firstError.reason,
                );
                settingKey = 'python.defaultInterpreterPath';
                break;
            default:
                continue;
        }

        const openSettings = l10n.t('Open Settings');
        const result = await showWarningMessage(message, openSettings);
        if (result === openSettings) {
            await commands.executeCommand('workbench.action.openSettings', settingKey);
        }
    }
}

/**
 * Extract the pythonProjects[] setting lookup into a dedicated function.
 * Returns the manager ID if found in pythonProjects[] for the given scope, else undefined.
 */
function getProjectSpecificEnvManager(projectManager: PythonProjectManager, scope: Uri): string | undefined {
    const config = getConfiguration('python-envs', scope);
    const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);

    if (overrides.length > 0) {
        const pw = projectManager.get(scope);
        const w = getWorkspaceFolder(scope);
        if (pw && w) {
            const pwPath = path.resolve(pw.uri.fsPath);
            const matching = overrides.find((s) => path.resolve(w.uri.fsPath, s.path) === pwPath);
            if (matching && matching.envManager && matching.envManager.length > 0) {
                return matching.envManager;
            }
        }
    }
    return undefined;
}

/**
 * Try to resolve an interpreter path via nativeFinder and return a PriorityChainResult.
 * Returns undefined if resolution fails.
 */
async function tryResolveInterpreterPath(
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    interpreterPath: string,
    envManagers: EnvironmentManagers,
): Promise<PriorityChainResult | undefined> {
    try {
        const resolved: NativeEnvInfo = await nativeFinder.resolve(interpreterPath);

        if (resolved && resolved.executable) {
            const resolvedEnv = await api.resolveEnvironment(Uri.file(resolved.executable));

            // Find the appropriate manager - prefer the one from the resolved env, fall back to system
            let manager = envManagers.managers.find((m) => m.id === resolvedEnv?.envId.managerId);
            if (!manager) {
                manager = envManagers.getEnvironmentManager(SYSTEM_MANAGER_ID);
            }

            if (manager && resolvedEnv) {
                // Create a wrapper environment that uses the user's specified path
                const newEnv: PythonEnvironment = {
                    envId: {
                        id: `defaultInterpreterPath:${interpreterPath}`,
                        managerId: manager.id,
                    },
                    name: 'defaultInterpreterPath: ' + (resolved.version ?? ''),
                    displayName: 'defaultInterpreterPath: ' + (resolved.version ?? ''),
                    version: resolved.version ?? '',
                    displayPath: interpreterPath,
                    environmentPath: Uri.file(interpreterPath),
                    sysPrefix: resolved.prefix ?? '',
                    execInfo: {
                        run: {
                            executable: interpreterPath,
                        },
                    },
                };
                traceVerbose(
                    `[tryResolveInterpreterPath] Resolved '${interpreterPath}' to ${resolved.executable} (${resolved.version})`,
                );
                return { manager, environment: newEnv, source: 'defaultInterpreterPath' };
            }
        }
        traceVerbose(
            `[tryResolveInterpreterPath] Could not resolve '${interpreterPath}' - no executable or manager found`,
        );
    } catch (err) {
        traceVerbose(`[tryResolveInterpreterPath] Resolution failed for '${interpreterPath}': ${err}`);
    }
    return undefined;
}

/**
 * Register a configuration change listener for interpreter-related settings. When relevant settings change (defaultInterpreterPath, defaultEnvManager, pythonProjects),
 * re-run the priority chain to apply the new settings immediately.
 */
export function registerInterpreterSettingsChangeListener(
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
): Disposable {
    return onDidChangeConfiguration(async (e: ConfigurationChangeEvent) => {
        const relevantSettingsChanged =
            e.affectsConfiguration('python.defaultInterpreterPath') ||
            e.affectsConfiguration('python-envs.defaultEnvManager') ||
            e.affectsConfiguration('python-envs.pythonProjects');

        if (relevantSettingsChanged) {
            traceInfo(
                '[interpreterSelection] Interpreter settings changed, re-evaluating priority chain for all scopes',
            );
            // Re-run the interpreter selection priority chain to apply new settings immediately
            await applyInitialEnvironmentSelection(envManagers, projectManager, nativeFinder, api);
        }
    });
}
