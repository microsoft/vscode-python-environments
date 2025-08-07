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
import { traceError, traceVerbose } from '../../common/logging';
import { resolveVariables } from '../../common/utils/internalVariables';
import { getConfiguration, getWorkspaceFolder } from '../../common/workspace.apis';
import { showInformationMessage } from '../../common/window.apis';
import { EnvVarManager } from '../execution/envVariableManager';

/**
 * Manages injection of workspace-specific environment variables into VS Code terminals
 * using the GlobalEnvironmentVariableCollection API.
 */
export class TerminalEnvVarInjector implements Disposable {
    private disposables: Disposable[] = [];

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
                this.envVarCollection.clear();

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
        try {
            // Check if environment variable injection is enabled
            const config = getConfiguration('python', workspaceUri);
            const useEnvFile = config.get<boolean>('terminal.useEnvFile', false);
            const envFilePath = config.get<string>('envFile');
            
            // use scoped environment variable collection
            const envVarScope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });
            envVarScope.clear(); // Clear existing variables for this workspace

            // Check if python.envFile is set but useEnvFile is false (default) and show notification
            if (!useEnvFile && envFilePath) {
                traceVerbose(
                    `TerminalEnvVarInjector: python.envFile is set but python.terminal.useEnvFile is false for workspace: ${workspaceUri.fsPath}`,
                );
                
                // Show information message to user
                showInformationMessage(
                    'The python.envFile setting is configured but will not take effect in terminals. Enable the "python.terminal.useEnvFile" setting to use environment variables from .env files in terminals.',
                    'Open Settings'
                ).then((selection) => {
                    if (selection === 'Open Settings') {
                        // Open VS Code settings to the python.terminal.useEnvFile setting
                        import('vscode').then(vscode => {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'python.terminal.useEnvFile');
                        });
                    }
                });
            }

            if (!useEnvFile) {
                traceVerbose(
                    `TerminalEnvVarInjector: Environment variable injection disabled for workspace: ${workspaceUri.fsPath}`,
                );
                return; // Injection is disabled
            }

            const envVars = await this.envVarManager.getEnvironmentVariables(workspaceUri);

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
                return; // No .env file to inject
            }

            for (const [key, value] of Object.entries(envVars)) {
                if (value === undefined) {
                    // Remove the environment variable if the value is undefined
                    envVarScope.delete(key);
                } else {
                    envVarScope.replace(key, value);
                }
            }
        } catch (error) {
            traceError(
                `TerminalEnvVarInjector: Error injecting environment variables for workspace ${workspaceUri.fsPath}:`,
                error,
            );
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
}
