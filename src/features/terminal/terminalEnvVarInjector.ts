// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import * as fsapi from 'fs-extra';
import { Disposable, Uri, workspace, GlobalEnvironmentVariableCollection } from 'vscode';
import { traceVerbose, traceError } from '../../common/logging';
import { getConfiguration, onDidChangeConfiguration } from '../../common/workspace.apis';
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

        // Listen for configuration changes to python.envFile setting
        this.disposables.push(
            onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('python.envFile')) {
                    traceVerbose('TerminalEnvVarInjector: python.envFile setting changed, reloading env vars');
                    this.updateEnvironmentVariables().catch((error) => {
                        traceError('TerminalEnvVarInjector: Error updating env vars after setting change:', error);
                    });
                }
            }),
        );

        // Listen for environment variable changes from the manager
        this.disposables.push(
            this.envVarManager.onDidChangeEnvironmentVariables(() => {
                traceVerbose('TerminalEnvVarInjector: Environment variables changed, reloading');
                this.updateEnvironmentVariables().catch((error) => {
                    traceError('TerminalEnvVarInjector: Error updating env vars after change event:', error);
                });
            }),
        );

        // Initial load of environment variables
        await this.updateEnvironmentVariables();
    }

    /**
     * Update environment variables in the terminal collection.
     */
    private async updateEnvironmentVariables(): Promise<void> {
        try {
            // Clear existing environment variables
            traceVerbose('TerminalEnvVarInjector: Clearing existing environment variables');
            this.envVarCollection.clear();

            // Get environment variables for all workspace folders
            const workspaceFolders = workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                traceVerbose('TerminalEnvVarInjector: No workspace folders found, skipping env var injection');
                return;
            }

            // Process environment variables for each workspace folder
            for (const folder of workspaceFolders) {
                await this.injectEnvironmentVariablesForWorkspace(folder.uri);
            }

            traceVerbose('TerminalEnvVarInjector: Environment variable injection completed');
        } catch (error) {
            traceError('TerminalEnvVarInjector: Error updating environment variables:', error);
        }
    }

    /**
     * Inject environment variables for a specific workspace.
     */
    private async injectEnvironmentVariablesForWorkspace(workspaceUri: Uri): Promise<void> {
        try {
            traceVerbose(`TerminalEnvVarInjector: Processing workspace: ${workspaceUri.fsPath}`);

            // Get environment variables for this workspace
            const envVars = await this.envVarManager.getEnvironmentVariables(workspaceUri);

            // Track which .env file is being used for logging
            const config = getConfiguration('python', workspaceUri);
            const envFilePath = config.get<string>('envFile');
            const resolvedEnvFilePath = envFilePath ? path.resolve(envFilePath) : undefined;
            const defaultEnvFilePath = path.join(workspaceUri.fsPath, '.env');

            let activeEnvFilePath: string | undefined;
            if (resolvedEnvFilePath && (await fsapi.pathExists(resolvedEnvFilePath))) {
                activeEnvFilePath = resolvedEnvFilePath;
                traceVerbose(`TerminalEnvVarInjector: Using python.envFile setting: ${activeEnvFilePath}`);
            } else if (await fsapi.pathExists(defaultEnvFilePath)) {
                activeEnvFilePath = defaultEnvFilePath;
                traceVerbose(`TerminalEnvVarInjector: Using default .env file: ${activeEnvFilePath}`);
            } else {
                traceVerbose(`TerminalEnvVarInjector: No .env file found for workspace: ${workspaceUri.fsPath}`);
            }

            // Inject environment variables into the collection
            let injectedCount = 0;
            for (const [key, value] of Object.entries(envVars)) {
                if (value !== undefined && value !== process.env[key]) {
                    // Only inject if the value is different from the current process environment
                    this.envVarCollection.replace(key, value);
                    injectedCount++;
                    traceVerbose(`TerminalEnvVarInjector: Injected ${key}=${value}`);
                }
            }

            if (injectedCount > 0) {
                traceVerbose(
                    `TerminalEnvVarInjector: Injected ${injectedCount} environment variables for workspace: ${workspaceUri.fsPath}`,
                );
            } else {
                traceVerbose(
                    `TerminalEnvVarInjector: No environment variables to inject for workspace: ${workspaceUri.fsPath}`,
                );
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
}