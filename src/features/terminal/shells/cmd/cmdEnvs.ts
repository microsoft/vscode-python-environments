import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../../api';
import { traceError } from '../../../../common/logging';
import { ShellConstants } from '../../../common/shellConstants';
import { getShellActivationCommand, getShellCommandAsString } from '../common/shellUtils';
import { ShellEnvsProvider } from '../startupProvider';
import { CMD_ENV_KEY } from './cmdConstants';

export class CmdEnvsProvider implements ShellEnvsProvider {
    readonly shellType: string = ShellConstants.CMD;
    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const cmdActivation = getShellActivationCommand(this.shellType, env);
            if (cmdActivation) {
                const command = getShellCommandAsString(this.shellType, cmdActivation);
                collection.replace(CMD_ENV_KEY, command);
            } else {
                collection.delete(CMD_ENV_KEY);
            }
        } catch (err) {
            traceError('Failed to update CMD environment variables', err);
            collection.delete(CMD_ENV_KEY);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(CMD_ENV_KEY);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[CMD_ENV_KEY, undefined]]);
        }

        try {
            const cmdActivation = getShellActivationCommand(this.shellType, env);
            if (cmdActivation) {
                return new Map([[CMD_ENV_KEY, getShellCommandAsString(this.shellType, cmdActivation)]]);
            }
            return undefined;
        } catch (err) {
            traceError('Failed to get CMD environment variables', err);
            return undefined;
        }
    }
}
