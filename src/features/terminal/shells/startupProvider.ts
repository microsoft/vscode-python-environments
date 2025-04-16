import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../api';

export enum ShellSetupState {
    NotSetup,
    Setup,
    NotInstalled,
}

export enum ShellScriptEditState {
    NotEdited,
    Edited,
    NotInstalled,
}

export interface ShellStartupScriptProvider {
    name: string;
    isSetup(): Promise<ShellSetupState>;
    setupScripts(): Promise<ShellScriptEditState>;
    teardownScripts(): Promise<ShellScriptEditState>;
}

export interface ShellEnvsProvider {
    readonly shellType: string;
    updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): void;
    removeEnvVariables(envVars: EnvironmentVariableCollection): void;
    getEnvVariables(env?: PythonEnvironment): Map<string, string | undefined> | undefined;
}
