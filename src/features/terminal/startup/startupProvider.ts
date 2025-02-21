import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../api';

export interface ShellStartupProvider {
    isSetup(): Promise<boolean>;
    setupScripts(): Promise<void>;
    teardownScripts(): Promise<void>;
    updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void>;
    removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void>;
    getEnvVariables(env: PythonEnvironment): Promise<Map<string, string> | undefined>;
}
