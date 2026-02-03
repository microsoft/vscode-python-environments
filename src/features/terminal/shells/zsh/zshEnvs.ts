import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../../api';
import { traceError } from '../../../../common/logging';
import { ShellConstants } from '../../../common/shellConstants';
import { getShellActivationCommand, getShellCommandAsString } from '../common/shellUtils';
import { ShellEnvsProvider } from '../startupProvider';
import { ZSH_ENV_KEY } from './zshConstants';

export class ZshEnvsProvider implements ShellEnvsProvider {
    readonly shellType: string = ShellConstants.ZSH;

    updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): void {
        try {
            const zshActivation = getShellActivationCommand(this.shellType, env);
            if (zshActivation) {
                const command = getShellCommandAsString(this.shellType, zshActivation);
                const v = collection.get(ZSH_ENV_KEY);
                if (v?.value === command) {
                    return;
                }
                collection.replace(ZSH_ENV_KEY, command);
            } else {
                collection.delete(ZSH_ENV_KEY);
            }
        } catch (err) {
            traceError('Failed to update env variables for zsh', err);
            collection.delete(ZSH_ENV_KEY);
        }
    }

    removeEnvVariables(collection: EnvironmentVariableCollection): void {
        collection.delete(ZSH_ENV_KEY);
    }

    getEnvVariables(env?: PythonEnvironment): Map<string, string | undefined> | undefined {
        if (!env) {
            return new Map([[ZSH_ENV_KEY, undefined]]);
        }

        try {
            const zshActivation = getShellActivationCommand(this.shellType, env);
            if (zshActivation) {
                const command = getShellCommandAsString(this.shellType, zshActivation);
                return new Map([[ZSH_ENV_KEY, command]]);
            }
            return undefined;
        } catch (err) {
            traceError('Failed to get env variables for zsh', err);
            return undefined;
        }
    }
}
