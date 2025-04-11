import { EnvironmentVariableCollection } from 'vscode';
import { traceError } from '../../../../common/logging';
import { ShellEnvsProvider } from '../startupProvider';
import { PythonEnvironment } from '../../../../api';
import { ShellConstants } from '../../../common/shellConstants';
import { POWERSHELL_ENV_KEY } from './pwshConstants';
import { getShellActivationCommand, getShellCommandAsString } from '../common/shellUtils';

export class PowerShellEnvsProvider implements ShellEnvsProvider {
    public readonly shellType: string = ShellConstants.PWSH;

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const pwshActivation = getShellActivationCommand(this.shellType, env);
            if (pwshActivation) {
                const command = getShellCommandAsString(this.shellType, pwshActivation);
                collection.replace(POWERSHELL_ENV_KEY, command);
            } else {
                collection.delete(POWERSHELL_ENV_KEY);
            }
        } catch (err) {
            traceError('Failed to update PowerShell environment variables', err);
            collection.delete(POWERSHELL_ENV_KEY);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(POWERSHELL_ENV_KEY);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[POWERSHELL_ENV_KEY, undefined]]);
        }

        try {
            const pwshActivation = getShellActivationCommand(this.shellType, env);
            if (pwshActivation) {
                return new Map([[POWERSHELL_ENV_KEY, getShellCommandAsString(this.shellType, pwshActivation)]]);
            }
            return undefined;
        } catch (err) {
            traceError('Failed to get PowerShell environment variables', err);
            return undefined;
        }
    }
}
