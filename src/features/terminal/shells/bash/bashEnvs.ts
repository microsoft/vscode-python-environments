import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../../api';
import { traceError } from '../../../../common/logging';
import { getActivationCommandForShell } from '../../../common/activation';
import { ShellConstants } from '../../../common/shellConstants';
import { ShellEnvsProvider } from '../startupProvider';
import { getCommandAsString } from '../utils';
import { BASH_ENV_KEY, ZSH_ENV_KEY } from './bashConstants';

export class BashEnvsProvider implements ShellEnvsProvider {
    constructor(public readonly shellType: 'bash' | 'gitbash') {}

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const bashActivation = getActivationCommandForShell(env, this.shellType);
            if (bashActivation) {
                const command = getCommandAsString(bashActivation, '&&');
                collection.replace(BASH_ENV_KEY, command);
            } else {
                collection.delete(BASH_ENV_KEY);
            }
        } catch (err) {
            traceError(`Failed to update env variables for ${this.shellType}`, err);
            collection.delete(BASH_ENV_KEY);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(BASH_ENV_KEY);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[BASH_ENV_KEY, undefined]]);
        }

        try {
            const bashActivation = getActivationCommandForShell(env, ShellConstants.BASH);
            if (bashActivation) {
                const command = getCommandAsString(bashActivation, '&&');
                return new Map([[BASH_ENV_KEY, command]]);
            }
            return undefined;
        } catch (err) {
            traceError(`Failed to get env variables for ${this.shellType}`, err);
            return undefined;
        }
    }
}

export class ZshEnvsProvider implements ShellEnvsProvider {
    public readonly shellType: string = ShellConstants.ZSH;
    async updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const zshActivation = getActivationCommandForShell(env, ShellConstants.ZSH);
            if (zshActivation) {
                const command = getCommandAsString(zshActivation, '&&');
                envVars.replace(ZSH_ENV_KEY, command);
            } else {
                envVars.delete(ZSH_ENV_KEY);
            }
        } catch (err) {
            traceError('Failed to update env variables for zsh', err);
            envVars.delete(ZSH_ENV_KEY);
        }
    }

    async removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void> {
        envVars.delete(ZSH_ENV_KEY);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[ZSH_ENV_KEY, undefined]]);
        }

        try {
            const zshActivation = getActivationCommandForShell(env, ShellConstants.ZSH);
            return zshActivation ? new Map([[ZSH_ENV_KEY, getCommandAsString(zshActivation, '&&')]]) : undefined;
        } catch (err) {
            traceError('Failed to get env variables for zsh', err);
            return undefined;
        }
    }
}
