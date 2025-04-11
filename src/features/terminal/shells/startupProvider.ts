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
    updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void>;
    removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void>;
    getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined>;
}
