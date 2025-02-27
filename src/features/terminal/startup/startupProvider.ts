import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../api';

export interface ShellStartupProvider {
    name: string;
    isSetup(): Promise<boolean>;
    setupScripts(): Promise<boolean>;
    teardownScripts(): Promise<boolean>;
    updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void>;
    removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void>;
    getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined>;
}
