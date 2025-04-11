import { EnvironmentVariableCollection } from 'vscode';
import { traceError } from '../../../../common/logging';
import { ShellEnvsProvider } from '../startupProvider';
import { getCommandAsString } from '../utils';
import { PythonEnvironment } from '../../../../api';
import { getActivationCommandForShell } from '../../../common/activation';
import { ShellConstants } from '../../../common/shellConstants';
import { POWERSHELL_ENV_KEY } from './pwshConstants';

export class PowerShellEnvsProvider implements ShellEnvsProvider {
    public readonly shellType: string = ShellConstants.PWSH;

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const pwshActivation = getActivationCommandForShell(env, ShellConstants.PWSH);
            if (pwshActivation) {
                const command = getCommandAsString(pwshActivation, '&&');
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
            const pwshActivation = getActivationCommandForShell(env, ShellConstants.PWSH);
            return pwshActivation
                ? new Map([[POWERSHELL_ENV_KEY, getCommandAsString(pwshActivation, '&&')]])
                : undefined;
        } catch (err) {
            traceError('Failed to get PowerShell environment variables', err);
            return undefined;
        }
    }
}
