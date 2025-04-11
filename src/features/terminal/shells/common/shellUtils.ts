import { PythonCommandRunConfiguration, PythonEnvironment } from '../../../../api';
import { isWindows } from '../../../../common/utils/platformUtils';
import { ShellConstants } from '../../../common/shellConstants';
import { quoteArgs } from '../../../execution/execUtils';

export function getCommandAsString(command: PythonCommandRunConfiguration[], delimiter: string): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        parts.push(quoteArgs([cmd.executable, ...args]).join(' '));
    }
    return parts.join(` ${delimiter} `);
}

export function getShellCommandAsString(shell: string, command: PythonCommandRunConfiguration[]): string {
    switch (shell) {
        case ShellConstants.NU:
            return getCommandAsString(command, ';');
        case ShellConstants.FISH:
            return getCommandAsString(command, '; and');
        case ShellConstants.BASH:
        case ShellConstants.SH:
        case ShellConstants.ZSH:
        case ShellConstants.PWSH:
        case ShellConstants.CMD:
        default:
            return getCommandAsString(command, '&&');
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
