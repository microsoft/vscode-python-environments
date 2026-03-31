// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fse from 'fs-extra';
import * as path from 'path';
import {
    Disposable,
    EnvironmentVariableScope,
    GlobalEnvironmentVariableCollection,
    workspace,
    WorkspaceFolder,
} from 'vscode';
import { ActivationStrings, Common } from '../../common/localize';
import { traceError, traceLog, traceVerbose } from '../../common/logging';
import { getGlobalPersistentState } from '../../common/persistentState';
import { resolveVariables } from '../../common/utils/internalVariables';
import { showInformationMessage } from '../../common/window.apis';
import { getConfiguration, getWorkspaceFolder } from '../../common/workspace.apis';
import { EnvVarManager } from '../execution/envVariableManager';

export const ENV_FILE_NOTIFICATION_DONT_SHOW_KEY = 'python-envs:terminal:ENV_FILE_NOTIFICATION_DONT_SHOW';

/**
 * Manages injection of workspace-specific environment variables into VS Code terminals
 * using the GlobalEnvironmentVariableCollection API.
 */
export class TerminalEnvVarInjector implements Disposable {
    private disposables: Disposable[] = [];
    // Track which .env variables we've set for each workspace to avoid clearing shell activation variables
    private envVarKeys: Map<string, Set<string>> = new Map();

    constructor(
        private readonly envVarCollection: GlobalEnvironmentVariableCollection,
        private readonly envVarManager: EnvVarManager,
    ) {
        this.initialize();
    }

    /**
     * Initialize the injector by setting up watchers and injecting initial environment variables.
     */
    private async initialize(): Promise<void> {
        traceVerbose('TerminalEnvVarInjector: Initializing environment variable injection');

        // Listen for environment variable changes from the manager
        this.disposables.push(
            this.envVarManager.onDidChangeEnvironmentVariables((args) => {
                if (!args.uri) {
                    // No specific URI, reload all workspaces
                    this.updateEnvironmentVariables().catch((error) => {
                        traceError('Failed to update environment variables:', error);
                    });
                    return;
                }

                const affectedWorkspace = getWorkspaceFolder(args.uri);
                if (!affectedWorkspace) {
                    // No workspace folder found for this URI, reloading all workspaces
                    this.updateEnvironmentVariables().catch((error) => {
                        traceError('Failed to update environment variables:', error);
                    });
                    return;
                }

                // Check if env file injection is enabled when variables change
                const config = getConfiguration('python', args.uri);
                const useEnvFile = config.get<boolean>('terminal.useEnvFile', false);
                const envFilePath = config.get<string>('envFile');

                // Only show notification when env vars change and we have an env file but injection is disabled
                if (!useEnvFile && envFilePath) {
                    this.showEnvFileNotification().catch((error) => {
                        traceError('Failed to show env file notification:', error);
                    });
                }

                if (args.changeType === 2) {
                    // FileChangeType.Deleted
                    this.clearWorkspaceVariables(affectedWorkspace);
                } else {
                    this.updateEnvironmentVariables(affectedWorkspace).catch((error) => {
                        traceError('Failed to update environment variables:', error);
                    });
                }
            }),
        );

        // Listen for changes to the python.envFile setting
        this.disposables.push(
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('python.envFile') || e.affectsConfiguration('python.terminal.useEnvFile')) {
                    traceVerbose(
                        'TerminalEnvVarInjector: python.envFile or python.terminal.useEnvFile setting changed, updating environment variables',
                    );
                    this.updateEnvironmentVariables().catch((error) => {
                        traceError('Failed to update environment variables:', error);
                    });
                }
            }),
        );

        // Initial load of environment variables
        await this.updateEnvironmentVariables();
    }

    /**
     * Update environment variables in the terminal collection.
     */
    private async updateEnvironmentVariables(workspaceFolder?: WorkspaceFolder): Promise<void> {
        try {
            if (workspaceFolder) {
                // Update only the specified workspace
                traceVerbose(
                    `TerminalEnvVarInjector: Updating environment variables for workspace: ${workspaceFolder.uri.fsPath}`,
                );
                await this.injectEnvironmentVariablesForWorkspace(workspaceFolder);
            } else {
                // No provided workspace - update all workspaces

                const workspaceFolders = workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    traceVerbose('TerminalEnvVarInjector: No workspace folders found, skipping env var injection');
                    return;
                }

                traceVerbose('TerminalEnvVarInjector: Updating environment variables for all workspaces');
                for (const folder of workspaceFolders) {
                    await this.injectEnvironmentVariablesForWorkspace(folder);
                }
            }

            traceVerbose('TerminalEnvVarInjector: Environment variable injection completed');
        } catch (error) {
            traceError('TerminalEnvVarInjector: Error updating environment variables:', error);
        }
    }

    /**
     * Inject environment variables for a specific workspace.
     */
    private async injectEnvironmentVariablesForWorkspace(workspaceFolder: WorkspaceFolder): Promise<void> {
        const workspaceUri = workspaceFolder.uri;
        const workspaceKey = workspaceUri.fsPath;

        try {
            const envVars = await this.envVarManager.getEnvironmentVariables(workspaceUri);

            // use scoped environment variable collection
            const envVarScope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });

            // Check if env file injection is enabled
            const config = getConfiguration('python', workspaceUri);
            const useEnvFile = config.get<boolean>('terminal.useEnvFile', false);
            const envFilePath = config.get<string>('envFile');

            if (!useEnvFile) {
                traceVerbose(
                    `TerminalEnvVarInjector: Env file injection disabled for workspace: ${workspaceUri.fsPath}`,
                );
                // Clear only the .env variables we previously set, not shell activation variables
                this.clearTrackedEnvVariables(envVarScope, workspaceKey);
                return;
            }

            // Track which .env file is being used for logging
            const resolvedEnvFilePath: string | undefined = envFilePath
                ? path.resolve(resolveVariables(envFilePath, workspaceUri))
                : undefined;
            const defaultEnvFilePath: string = path.join(workspaceUri.fsPath, '.env');

            let activeEnvFilePath: string = resolvedEnvFilePath || defaultEnvFilePath;
            if (activeEnvFilePath && (await fse.pathExists(activeEnvFilePath))) {
                traceVerbose(`TerminalEnvVarInjector: Using env file: ${activeEnvFilePath}`);
            } else {
                traceVerbose(
                    `TerminalEnvVarInjector: No .env file found for workspace: ${workspaceUri.fsPath}, not injecting environment variables.`,
                );
                // Clear only the .env variables we previously set, not shell activation variables
                this.clearTrackedEnvVariables(envVarScope, workspaceKey);
                return;
            }

            // Get previously tracked keys for this workspace
            const previousKeys = this.envVarKeys.get(workspaceKey) || new Set<string>();
            const currentKeys = new Set<string>();

            // Delete variables that were previously set but are no longer in the .env file.
            // This ensures that when variables are commented out or removed from .env,
            // they are properly removed from the terminal environment without affecting
            // shell activation variables set by ShellStartupActivationVariablesManager.
            for (const key of previousKeys) {
                if (!(key in envVars)) {
                    envVarScope.delete(key);
                }
            }

            // Set/update current variables
            for (const [key, value] of Object.entries(envVars)) {
                if (value !== undefined) {
                    envVarScope.replace(key, value);
                    currentKeys.add(key);
                }
            }

            // Update tracking with current keys
            this.envVarKeys.set(workspaceKey, currentKeys);
        } catch (error) {
            traceError(
                `TerminalEnvVarInjector: Error injecting environment variables for workspace ${workspaceUri.fsPath}:`,
                error,
            );
        }
    }

    /**
     * Show a notification about env file injection being disabled, with a "Don't Show Again" option.
     */
    private async showEnvFileNotification(): Promise<void> {
        const state = await getGlobalPersistentState();
        const dontShow = await state.get<boolean>(ENV_FILE_NOTIFICATION_DONT_SHOW_KEY);
        if (dontShow) {
            return;
        }

        const result = await showInformationMessage(ActivationStrings.envFileInjectionDisabled, Common.dontShowAgain);
        if (result === Common.dontShowAgain) {
            await state.set(ENV_FILE_NOTIFICATION_DONT_SHOW_KEY, true);
            traceLog(`User selected "Don't Show Again" for env file notification`);
        }
    }

    /**
     * Dispose of the injector and clean up resources.
     */
    dispose(): void {
        traceVerbose('TerminalEnvVarInjector: Disposing');
        this.disposables.forEach((disposable) => disposable.dispose());
        this.disposables = [];

        // Clear all environment variables from the collection
        this.envVarCollection.clear();
    }

    private getEnvironmentVariableCollectionScoped(scope: EnvironmentVariableScope = {}) {
        const envVarCollection = this.envVarCollection as GlobalEnvironmentVariableCollection;
        return envVarCollection.getScoped(scope);
    }

    /**
     * Clear all environment variables for a workspace.
     */
    private clearWorkspaceVariables(workspaceFolder: WorkspaceFolder): void {
        try {
            const scope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });
            scope.clear();
        } catch (error) {
            traceError(`Failed to clear environment variables for workspace ${workspaceFolder.uri.fsPath}:`, error);
        }
    }

    /**
     * Clear only the .env variables we've tracked, not shell activation variables.
     */
    private clearTrackedEnvVariables(
        envVarScope: ReturnType<GlobalEnvironmentVariableCollection['getScoped']>,
        workspaceKey: string,
    ): void {
        const trackedKeys = this.envVarKeys.get(workspaceKey);
        if (trackedKeys) {
            for (const key of trackedKeys) {
                envVarScope.delete(key);
            }
            this.envVarKeys.delete(workspaceKey);
        }
    }
}
