import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../../api';
import { traceError } from '../../../../common/logging';
import { ShellConstants } from '../../../common/shellConstants';
import { getShellActivationCommand, getShellCommandAsString } from '../common/shellUtils';
import { ShellEnvsProvider } from '../startupProvider';
import { FISH_ENV_KEY } from './fishConstants';

export class FishEnvsProvider implements ShellEnvsProvider {
    readonly shellType: string = ShellConstants.FISH;
    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const fishActivation = getShellActivationCommand(this.shellType, env);
            if (fishActivation) {
                const command = getShellCommandAsString(this.shellType, fishActivation);
                collection.replace(FISH_ENV_KEY, command);
            } else {
                collection.delete(FISH_ENV_KEY);
            }
        } catch (err) {
            traceError('Failed to update Fish environment variables', err);
            collection.delete(FISH_ENV_KEY);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(FISH_ENV_KEY);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[FISH_ENV_KEY, undefined]]);
        }

        try {
            const fishActivation = getShellActivationCommand(this.shellType, env);
            if (fishActivation) {
                return new Map([[FISH_ENV_KEY, getShellCommandAsString(this.shellType, fishActivation)]]);
            }
            return undefined;
        } catch (err) {
            traceError('Failed to get Fish environment variables', err);
            return undefined;
        }
    }
}
