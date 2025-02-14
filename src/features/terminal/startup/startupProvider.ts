import { GlobalEnvironmentVariableCollection, Uri } from 'vscode';

export interface ShellStartupProvider {
    isSetup(): Promise<boolean>;
    setupScripts(): Promise<void>;
    removeScripts(): Promise<void>;
    updateEnvVariables(global: GlobalEnvironmentVariableCollection, scope?: Uri): Promise<void>;
    removeEnvVariables(global: GlobalEnvironmentVariableCollection, scope?: Uri): Promise<void>;
}
