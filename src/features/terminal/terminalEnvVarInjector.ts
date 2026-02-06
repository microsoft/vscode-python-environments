// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fse from 'fs-extra';
import * as path from 'path';
import { Disposable, EnvironmentVariableScope, GlobalEnvironmentVariableCollection, WorkspaceFolder } from 'vscode';
import { traceError, traceVerbose } from '../../common/logging';
import { resolveVariables } from '../../common/utils/internalVariables';
import { showInformationMessage } from '../../common/window.apis';
import {
    getConfiguration,
    getWorkspaceFolder,
    getWorkspaceFolders,
    onDidChangeConfiguration,
} from '../../common/workspace.apis';
import { EnvVarManager } from '../execution/envVariableManager';

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
                    showInformationMessage(
                        'An environment file is configured but terminal environment injection is disabled. Enable "python.terminal.useEnvFile" to use environment variables from .env files in terminals.',
                    );
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
            onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('python.envFile')) {
                    traceVerbose(
                        'TerminalEnvVarInjector: python.envFile setting changed, updating environment variables',
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

                const workspaceFolders = getWorkspaceFolders();
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
        // Use path.resolve() for safe cross-platform map key (Windows \ vs POSIX /)
        const workspaceKey = path.resolve(workspaceUri.fsPath);

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
     * Dispose of the injector and clean up resources.
     * Only clears the .env variables this injector has tracked, preserving
     * shell activation variables (VSCODE_PYTHON_*_ACTIVATE) set by
     * ShellStartupActivationVariablesManager on the same shared collection.
     */
    dispose(): void {
        traceVerbose('TerminalEnvVarInjector: Disposing');
        this.disposables.forEach((disposable) => disposable.dispose());
        this.disposables = [];

        // Only remove the .env keys we tracked — do NOT call envVarCollection.clear().
        // The collection is shared with ShellStartupActivationVariablesManager which
        // contributes VSCODE_PYTHON_*_ACTIVATE variables that must survive disposal.
        const workspaceFolders = getWorkspaceFolders();
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const scope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder: folder });
                this.clearTrackedEnvVariables(scope, path.resolve(folder.uri.fsPath));
            }
        }
    }

    private getEnvironmentVariableCollectionScoped(scope: EnvironmentVariableScope = {}) {
        const envVarCollection = this.envVarCollection as GlobalEnvironmentVariableCollection;
        return envVarCollection.getScoped(scope);
    }

    /**
     * Clear .env variables for a workspace when the .env file is deleted.
     * Only removes tracked keys, preserving shell activation variables
     * (VSCODE_PYTHON_*_ACTIVATE) set by ShellStartupActivationVariablesManager.
     */
    private clearWorkspaceVariables(workspaceFolder: WorkspaceFolder): void {
        try {
            const scope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });
            this.clearTrackedEnvVariables(scope, path.resolve(workspaceFolder.uri.fsPath));
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
