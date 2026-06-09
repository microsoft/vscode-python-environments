import { PythonCommandRunConfiguration, PythonEnvironment } from '../../../../api';
import { isWindows } from '../../../../common/utils/platformUtils';
import { getConfiguration } from '../../../../common/workspace.apis';
import { ShellConstants } from '../../../common/shellConstants';
import { quoteArgs } from '../../../execution/execUtils';

/**
 * Shells that support a leading space to prevent command from being saved in history.
 * - Bash: When HISTCONTROL contains 'ignorespace' or 'ignoreboth'
 * - Zsh: When setopt HIST_IGNORE_SPACE is enabled
 * - Git Bash: Uses bash under the hood, same behavior as Bash
 */
export const shellsWithLeadingSpaceHistorySupport = new Set([
    ShellConstants.BASH,
    ShellConstants.ZSH,
    ShellConstants.GITBASH,
]);

const defaultShellDelimiter = '&&';
const shellDelimiterByShell = new Map<string, string>([
    [ShellConstants.PWSH, ';'],
    [ShellConstants.NU, ';'],
    [ShellConstants.FISH, '; and'],
]);

export function getShellCommandAsString(shell: string, command: PythonCommandRunConfiguration[]): string {
    // Return empty string for empty command arrays (e.g., when activation is intentionally skipped)
    if (command.length === 0) {
        return '';
    }

    const delimiter = shellDelimiterByShell.get(shell) ?? defaultShellDelimiter;
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        parts.push(quoteArgs([normalizeShellPath(cmd.executable, shell), ...args]).join(' '));
    }

    let commandStr = parts.join(` ${delimiter} `);
    if (shell === ShellConstants.PWSH && parts.length > 1) {
        commandStr = parts.map((p) => `(${p})`).join(` ${delimiter} `);
    }

    // Add a leading space for shells that support history ignore with leading space.
    // This prevents the activation command from being saved in bash/zsh history
    // when HISTCONTROL=ignorespace (bash) or setopt HIST_IGNORE_SPACE (zsh) is set.
    if (shellsWithLeadingSpaceHistorySupport.has(shell)) {
        return ` ${commandStr}`;
    }
    return commandStr;
}

// Shells whose bare `deactivate` command is a shell function/alias defined by venv's
// `activate` script. These can disappear (e.g. on session restore where VIRTUAL_ENV
// persists but the shell function does not), so we must guard the call with an
// existence check before sending it to the terminal — otherwise the shell prints
// `deactivate: command not found`.
const bareDeactivateGuardByShell = new Map<string, (cmd: string) => string>([
    // POSIX-family shells: `command -v <name>` is the portable existence check.
    [ShellConstants.BASH, (cmd) => `command -v deactivate >/dev/null 2>&1 && ${cmd.trimStart()}`],
    [ShellConstants.SH, (cmd) => `command -v deactivate >/dev/null 2>&1 && ${cmd.trimStart()}`],
    [ShellConstants.ZSH, (cmd) => `command -v deactivate >/dev/null 2>&1 && ${cmd.trimStart()}`],
    [ShellConstants.KSH, (cmd) => `command -v deactivate >/dev/null 2>&1 && ${cmd.trimStart()}`],
    [ShellConstants.GITBASH, (cmd) => `command -v deactivate >/dev/null 2>&1 && ${cmd.trimStart()}`],
    // fish uses `functions -q` for function existence.
    [ShellConstants.FISH, (cmd) => `functions -q deactivate; and ${cmd.trimStart()}`],
    // PowerShell: Get-Command returns silently if not found with -ErrorAction SilentlyContinue.
    [ShellConstants.PWSH, (cmd) => `if (Get-Command deactivate -ErrorAction SilentlyContinue) { ${cmd.trimStart()} }`],
]);

/**
 * Returns the bare `deactivate` token if and only if `command` represents a single,
 * bare invocation of a shell function/alias literally named `deactivate` — meaning
 * it is safe and meaningful to gate on the existence of that function in the shell.
 *
 * Returns `undefined` for anything else (full paths like `path/to/deactivate.bat`,
 * multi-token forms like `conda deactivate`, `pyenv shell --unset`, `overlay hide ...`,
 * etc.), since those have different failure modes that should not be silently swallowed.
 *
 * The token is normalized to lowercase so the generated guard is consistent across
 * shells (notably PowerShell, which is case-insensitive).
 */
function bareDeactivateInvocation(command: string): string | undefined {
    const trimmed = command.trim();
    return trimmed.toLowerCase() === 'deactivate' ? 'deactivate' : undefined;
}

/**
 * Wraps a deactivation command in a shell-specific existence guard so that sending
 * it to a terminal where the `deactivate` shell function no longer exists does not
 * print `deactivate: command not found`.
 *
 * Only applies when the command is a single bare `deactivate` token and the shell
 * has a known guard template. All other deactivation forms (cmd's `deactivate.bat`
 * path, `conda deactivate`, `pyenv shell --unset`, nu's `overlay hide ...`, etc.)
 * are returned unchanged — their failure modes are legitimate and should surface.
 */
export function wrapDeactivationCommand(shell: string, command: string): string {
    const bare = bareDeactivateInvocation(command);
    if (!bare) {
        return command;
    }
    const guard = bareDeactivateGuardByShell.get(shell);
    if (!guard) {
        return command;
    }
    const wrapped = guard(bare);
    // Preserve the leading-space history-ignore behavior for shells that honor it.
    if (shellsWithLeadingSpaceHistorySupport.has(shell)) {
        return ` ${wrapped}`;
    }
    return wrapped;
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

export function isWsl(): boolean {
    // WSL sets these environment variables
    return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || process.env.WSLENV);
}

export async function getShellIntegrationEnabledCache(): Promise<boolean> {
    const shellIntegrationInspect =
        getConfiguration('terminal.integrated').inspect<boolean>('shellIntegration.enabled');

    let shellIntegrationEnabled = true;
    if (shellIntegrationInspect) {
        // Priority: workspaceFolder > workspace > globalRemoteValue > globalLocalValue > global > default
        const inspectValue = shellIntegrationInspect as Record<string, unknown>;

        if (shellIntegrationInspect.workspaceFolderValue !== undefined) {
            shellIntegrationEnabled = shellIntegrationInspect.workspaceFolderValue;
        } else if (shellIntegrationInspect.workspaceValue !== undefined) {
            shellIntegrationEnabled = shellIntegrationInspect.workspaceValue;
        } else if ('globalRemoteValue' in shellIntegrationInspect && inspectValue.globalRemoteValue !== undefined) {
            shellIntegrationEnabled = inspectValue.globalRemoteValue as boolean;
        } else if ('globalLocalValue' in shellIntegrationInspect && inspectValue.globalLocalValue !== undefined) {
            shellIntegrationEnabled = inspectValue.globalLocalValue as boolean;
        } else if (shellIntegrationInspect.globalValue !== undefined) {
            shellIntegrationEnabled = shellIntegrationInspect.globalValue;
        } else if (shellIntegrationInspect.defaultValue !== undefined) {
            shellIntegrationEnabled = shellIntegrationInspect.defaultValue;
        }
    }

    return shellIntegrationEnabled;
}

// Shells that support shell integration way of environment activation.
// CMD is not listed here, but we still want to support activation via profile modification.
export const shellIntegrationSupportedShells = [
    ShellConstants.PWSH,
    ShellConstants.BASH,
    ShellConstants.GITBASH,
    ShellConstants.FISH,
    ShellConstants.ZSH,
];

/**
 * Determines whether profile-based activation should be used instead of shell integration.
 * Profile activation is preferred when:
 * - Running in WSL
 * - The shell type doesn't support shell integration (e.g., cmd)
 */
export function shouldUseProfileActivation(shellType: string): boolean {
    return isWsl() || !shellIntegrationSupportedShells.includes(shellType);
}
