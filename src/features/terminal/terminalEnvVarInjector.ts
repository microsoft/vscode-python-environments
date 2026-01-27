// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fse from 'fs-extra';
import * as path from 'path';
import {
    Disposable,
    EnvironmentVariableCollection,
    EnvironmentVariableScope,
    GlobalEnvironmentVariableCollection,
    Uri,
    window,
    workspace,
    WorkspaceFolder,
} from 'vscode';
import { traceError, traceVerbose } from '../../common/logging';
import { resolveVariables } from '../../common/utils/internalVariables';
import { getConfiguration, getWorkspaceFolder } from '../../common/workspace.apis';
import { EnvVarManager } from '../execution/envVariableManager';

/**
 * Manages injection of workspace-specific environment variables into VS Code terminals
 * using the GlobalEnvironmentVariableCollection API.
 */
export class TerminalEnvVarInjector implements Disposable {
    private disposables: Disposable[] = [];

    /**
     * Track which environment variables we've set per workspace to properly handle
     * variables that are removed/commented out in .env files.
     * Key: workspace fsPath, Value: Set of env var keys we've set for that workspace
     */
    protected readonly trackedEnvVars: Map<string, Set<string>> = new Map();

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
                    window.showInformationMessage(
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
            workspace.onDidChangeConfiguration((e) => {
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
            const envVarScope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });

            // Check if we should inject and get the env file path
            const shouldInject = await this.shouldInjectEnvVars(workspaceUri, envVarScope, workspaceKey);
            if (!shouldInject) {
                return;
            }

            // Get environment variables from the .env file
            const envVars = await this.envVarManager.getEnvironmentVariables(workspaceUri);

            // Apply the environment variable changes
            this.applyEnvVarChanges(envVarScope, envVars, workspaceKey);
        } catch (error) {
            traceError(
                `TerminalEnvVarInjector: Error injecting environment variables for workspace ${workspaceUri.fsPath}:`,
                error,
            );
        }
    }

    /**
     * Check if environment variables should be injected for the workspace.
     * Returns true if injection should proceed, false otherwise.
     */
    private async shouldInjectEnvVars(
        workspaceUri: Uri,
        envVarScope: EnvironmentVariableCollection,
        workspaceKey: string,
    ): Promise<boolean> {
        const config = getConfiguration('python', workspaceUri);
        const useEnvFile = config.get<boolean>('terminal.useEnvFile', false);
        const envFilePath = config.get<string>('envFile');

        if (!useEnvFile) {
            traceVerbose(`TerminalEnvVarInjector: Env file injection disabled for workspace: ${workspaceUri.fsPath}`);
            this.cleanupTrackedVars(envVarScope, workspaceKey);
            return false;
        }

        // Determine which .env file to use
        const resolvedEnvFilePath: string | undefined = envFilePath
            ? path.resolve(resolveVariables(envFilePath, workspaceUri))
            : undefined;
        const defaultEnvFilePath: string = path.join(workspaceUri.fsPath, '.env');
        const activeEnvFilePath: string = resolvedEnvFilePath || defaultEnvFilePath;

        if (activeEnvFilePath && (await fse.pathExists(activeEnvFilePath))) {
            traceVerbose(`TerminalEnvVarInjector: Using env file: ${activeEnvFilePath}`);
            return true;
        } else {
            traceVerbose(
                `TerminalEnvVarInjector: No .env file found for workspace: ${workspaceUri.fsPath}, not injecting environment variables.`,
            );
            this.cleanupTrackedVars(envVarScope, workspaceKey);
            return false;
        }
    }

    /**
     * Apply environment variable changes by comparing current and previous state.
     */
    protected applyEnvVarChanges(
        envVarScope: EnvironmentVariableCollection,
        envVars: { [key: string]: string | undefined },
        workspaceKey: string,
    ): void {
        const previousKeys = this.trackedEnvVars.get(workspaceKey) || new Set<string>();
        const currentKeys = new Set<string>();

        // Update/add current env vars from .env file
        for (const [key, value] of Object.entries(envVars)) {
            if (value === undefined || value === '') {
                // Variable explicitly unset in .env (e.g., VAR=)
                envVarScope.delete(key);
            } else {
                envVarScope.replace(key, value);
                currentKeys.add(key);
            }
        }

        // Delete keys that were previously set but are now gone from .env
        for (const oldKey of previousKeys) {
            if (!currentKeys.has(oldKey)) {
                traceVerbose(
                    `TerminalEnvVarInjector: Removing previously set env var '${oldKey}' from workspace ${workspaceKey}`,
                );
                envVarScope.delete(oldKey);
            }
        }

        // Update our tracking for this workspace
        this.trackedEnvVars.set(workspaceKey, currentKeys);
    }

    /**
     * Clean up previously tracked environment variables for a workspace.
     */
    protected cleanupTrackedVars(envVarScope: EnvironmentVariableCollection, workspaceKey: string): void {
        const previousKeys = this.trackedEnvVars.get(workspaceKey);
        if (previousKeys) {
            previousKeys.forEach((key) => envVarScope.delete(key));
            this.trackedEnvVars.delete(workspaceKey);
        }
    }

    /**
     * Dispose of the injector and clean up resources.
     */
    dispose(): void {
        traceVerbose('TerminalEnvVarInjector: Disposing');
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
        this.disposables = [];

        // Clear only the environment variables that we've set, preserving others (e.g., BASH_ENV)
        for (const [workspaceKey, trackedKeys] of this.trackedEnvVars.entries()) {
            try {
                // Try to find the workspace folder for proper scoping
                const workspaceFolder = workspace.workspaceFolders?.find((wf) => wf.uri.fsPath === workspaceKey);
                if (workspaceFolder) {
                    const scope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });
                    trackedKeys.forEach((key) => scope.delete(key));
                }
            } catch (error) {
                traceError(`Failed to clean up environment variables for workspace ${workspaceKey}:`, error);
            }
        }
        this.trackedEnvVars.clear();
    }

    private getEnvironmentVariableCollectionScoped(scope: EnvironmentVariableScope = {}) {
        const envVarCollection = this.envVarCollection as GlobalEnvironmentVariableCollection;
        return envVarCollection.getScoped(scope);
    }

    /**
     * Clear all environment variables for a workspace.
     */
    protected clearWorkspaceVariables(workspaceFolder: WorkspaceFolder): void {
        const workspaceKey = workspaceFolder.uri.fsPath;
        try {
            const scope = this.getEnvironmentVariableCollectionScoped({ workspaceFolder });

            // Only delete env vars that we've set, not ones set by other managers (e.g., BASH_ENV)
            const trackedKeys = this.trackedEnvVars.get(workspaceKey);
            if (trackedKeys) {
                trackedKeys.forEach((key) => scope.delete(key));
                this.trackedEnvVars.delete(workspaceKey);
            }
        } catch (error) {
            traceError(`Failed to clear environment variables for workspace ${workspaceFolder.uri.fsPath}:`, error);
        }
    }
}
