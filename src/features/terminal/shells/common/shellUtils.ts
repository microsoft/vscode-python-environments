import { window } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment } from '../../../../api';
import { traceInfo } from '../../../../common/logging';
import { isWindows } from '../../../../common/utils/platformUtils';
import { ShellConstants } from '../../../common/shellConstants';
import { quoteArgs } from '../../../execution/execUtils';

function getCommandAsString(command: PythonCommandRunConfiguration[], shell: string, delimiter: string): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        parts.push(quoteArgs([normalizeShellPath(cmd.executable, shell), ...args]).join(' '));
    }
    if (shell === ShellConstants.PWSH) {
        if (parts.length === 1) {
            return parts[0];
        }
        return parts.map((p) => `(${p})`).join(` ${delimiter} `);
    }
    return parts.join(` ${delimiter} `);
}

export function getShellCommandAsString(shell: string, command: PythonCommandRunConfiguration[]): string {
    switch (shell) {
        case ShellConstants.PWSH:
            return getCommandAsString(command, shell, ';');
        case ShellConstants.NU:
            return getCommandAsString(command, shell, ';');
        case ShellConstants.FISH:
            return getCommandAsString(command, shell, '; and');
        case ShellConstants.BASH:
        case ShellConstants.SH:
        case ShellConstants.ZSH:

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

export const PROFILE_TAG_START = '###PATH_START###';
export const PROFILE_TAG_END = '###PATH_END###';
export function extractProfilePath(content: string): string | undefined {
    // Extract only the part between the tags
    const profilePathRegex = new RegExp(`${PROFILE_TAG_START}\\r?\\n(.*?)\\r?\\n${PROFILE_TAG_END}`, 's');
    const match = content?.match(profilePathRegex);

    if (match && match[1]) {
        const extractedPath = match[1].trim();
        return extractedPath;
    }
    return undefined;
}

export function shellIntegrationForActiveTerminal(name: string, profile: string): boolean {
    const hasShellIntegration = window.activeTerminal?.shellIntegration;

    if (hasShellIntegration) {
        traceInfo(
            `SHELL: Shell integration is available in one of the terminals. Activate scripts will be evaluated at shell integration level. 
                Skipping modification of ${name} profile at: ${profile}`,
        );
        return true;
    }
    return false;
}
