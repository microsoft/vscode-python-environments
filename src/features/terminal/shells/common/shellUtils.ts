import { PythonCommandRunConfiguration, PythonEnvironment } from '../../../../api';
import { isWindows } from '../../../../common/utils/platformUtils';
import { ShellConstants } from '../../../common/shellConstants';
import { quoteArgs } from '../../../execution/execUtils';

function getCommandAsString(command: PythonCommandRunConfiguration[], shell: string, delimiter: string): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        parts.push(quoteArgs([normalizeShellPath(cmd.executable, shell), ...args]).join(' '));
    }
    return parts.join(` ${delimiter} `);
}

export function getShellCommandAsString(shell: string, command: PythonCommandRunConfiguration[]): string {
    switch (shell) {
        case ShellConstants.NU:
            return getCommandAsString(command, shell, ';');
        case ShellConstants.FISH:
            return getCommandAsString(command, shell, '; and');
        case ShellConstants.BASH:
        case ShellConstants.SH:
        case ShellConstants.ZSH:
        case ShellConstants.PWSH:
        case ShellConstants.CMD:
        case ShellConstants.GITBASH:
        default:
            return getCommandAsString(command, shell, '&&');
    }
}

export function normalizeShellPath(filePath: string, shellType?: string): string {
    if (isWindows() && shellType) {
        if (shellType.toLowerCase() === ShellConstants.GITBASH || shellType.toLowerCase() === 'git-bash') {
            return filePath.replace(/\\/g, '/').replace(/^\/([a-zA-Z])/, '$1:');
        }
    }
    return filePath;
}
export function getShellActivationCommand(
    shell: string,
    environment: PythonEnvironment,
): PythonCommandRunConfiguration[] | undefined {
    let activation: PythonCommandRunConfiguration[] | undefined;
    if (environment.execInfo?.shellActivation) {
        activation = environment.execInfo.shellActivation.get(shell);
        if (!activation) {
            activation = environment.execInfo.shellActivation.get('unknown');
        }
    }

    if (!activation) {
        activation = environment.execInfo?.activation;
    }

    return activation;
}
export function getShellDeactivationCommand(
    shell: string,
    environment: PythonEnvironment,
): PythonCommandRunConfiguration[] | undefined {
    let deactivation: PythonCommandRunConfiguration[] | undefined;
    if (environment.execInfo?.shellDeactivation) {
        deactivation = environment.execInfo.shellDeactivation.get(shell);
        if (!deactivation) {
            deactivation = environment.execInfo.shellDeactivation.get('unknown');
        }
    }

    if (!deactivation) {
        deactivation = environment.execInfo?.deactivation;
    }

    return deactivation;
}
