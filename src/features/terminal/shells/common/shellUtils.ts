import { PythonCommandRunConfiguration, PythonEnvironment } from '../../../../api';
import { traceInfo, traceVerbose } from '../../../../common/logging';
import { isWindows } from '../../../../common/utils/platformUtils';
import { activeTerminalShellIntegration } from '../../../../common/window.apis';
import { ShellConstants } from '../../../common/shellConstants';
import { quoteArgs } from '../../../execution/execUtils';

/**
 * Converts an array of Python command configurations into a single command string for the specified shell.
 * @param command Array of Python command configurations to convert
 * @param shell Shell type to format the command for
 * @param delimiter Delimiter to use between multiple commands
 * @returns Formatted command string suitable for the specified shell
 */
function getCommandAsString(command: PythonCommandRunConfiguration[], shell: string, delimiter: string): string {
    traceVerbose(`getCommandAsString: Converting ${command.length} commands for shell: ${shell}`);
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
    const result = parts.join(` ${delimiter} `);
    traceVerbose(`getCommandAsString: Generated command string: ${result}`);
    return result;
}

/**
 * Converts Python command configurations into a shell-specific command string.
 * Automatically selects the appropriate delimiter and formatting based on the shell type.
 * @param shell The shell type (e.g., 'bash', 'powershell', 'fish', etc.)
 * @param command Array of Python command configurations to execute
 * @returns A properly formatted command string for the specified shell
 */
export function getShellCommandAsString(shell: string, command: PythonCommandRunConfiguration[]): string {
    traceVerbose(`getShellCommandAsString: Processing ${command.length} commands for shell: ${shell}`);
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

/**
 * Normalizes a file path for the specified shell environment.
 * Handles Windows-specific path transformations for shells like Git Bash.
 * @param filePath The file path to normalize
 * @param shellType Optional shell type to determine normalization rules
 * @returns The normalized file path appropriate for the shell environment
 */
export function normalizeShellPath(filePath: string, shellType?: string): string {
    if (isWindows() && shellType) {
        if (shellType.toLowerCase() === ShellConstants.GITBASH || shellType.toLowerCase() === 'git-bash') {
            traceVerbose(`normalizeShellPath: Converting Windows path for Git Bash: ${filePath}`);
            const normalized = filePath.replace(/\\/g, '/').replace(/^\/([a-zA-Z])/, '$1:');
            traceVerbose(`normalizeShellPath: Normalized path: ${normalized}`);
            return normalized;
        }
    }
    return filePath;
}
/**
 * Retrieves the shell activation command for a Python environment.
 * Attempts to find shell-specific activation commands first, then falls back to generic activation.
 * @param shell The shell type to get activation command for
 * @param environment The Python environment containing activation information
 * @returns Array of command configurations for activation, or undefined if not available
 */
export function getShellActivationCommand(
    shell: string,
    environment: PythonEnvironment,
): PythonCommandRunConfiguration[] | undefined {
    traceVerbose(`getShellActivationCommand: Getting activation command for shell: ${shell}, env: ${environment.envId.id}`);
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

    if (activation) {
        traceVerbose(`getShellActivationCommand: Found activation command with ${activation.length} configurations`);
    } else {
        traceVerbose(`getShellActivationCommand: No activation command found for shell: ${shell}`);
    }

    return activation;
}
/**
 * Retrieves the shell deactivation command for a Python environment.
 * Attempts to find shell-specific deactivation commands first, then falls back to generic deactivation.
 * @param shell The shell type to get deactivation command for
 * @param environment The Python environment containing deactivation information
 * @returns Array of command configurations for deactivation, or undefined if not available
 */
export function getShellDeactivationCommand(
    shell: string,
    environment: PythonEnvironment,
): PythonCommandRunConfiguration[] | undefined {
    traceVerbose(`getShellDeactivationCommand: Getting deactivation command for shell: ${shell}, env: ${environment.envId.id}`);
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

    if (deactivation) {
        traceVerbose(`getShellDeactivationCommand: Found deactivation command with ${deactivation.length} configurations`);
    } else {
        traceVerbose(`getShellDeactivationCommand: No deactivation command found for shell: ${shell}`);
    }

    return deactivation;
}

export const PROFILE_TAG_START = '###PATH_START###';
export const PROFILE_TAG_END = '###PATH_END###';

/**
 * Extracts a profile path from content between special start and end tags.
 * Looks for content between PROFILE_TAG_START and PROFILE_TAG_END markers and returns the extracted path.
 * @param content The content string to search for profile path
 * @returns The extracted profile path as a string, or undefined if not found or invalid
 */
export function extractProfilePath(content: string): string | undefined {
    traceVerbose(`extractProfilePath: Attempting to extract profile path from content (${content?.length || 0} chars)`);
    // Extract only the part between the tags
    const profilePathRegex = new RegExp(`${PROFILE_TAG_START}\\r?\\n(.*?)\\r?\\n${PROFILE_TAG_END}`, 's');
    const match = content?.match(profilePathRegex);

    if (match && match[1]) {
        const extractedPath = match[1].trim();
        traceVerbose(`extractProfilePath: Successfully extracted path: ${extractedPath}`);
        return extractedPath;
    }
    traceVerbose(`extractProfilePath: No valid profile path found in content`);
    return undefined;
}

/**
 * Checks if shell integration is available for the active terminal and logs the status.
 * When shell integration is available, profile modifications are skipped in favor of shell-level evaluation.
 * @param name The name of the profile being processed
 * @param profile Optional path to the profile file
 * @returns True if shell integration is available and profile modification should be skipped, false otherwise
 */
export function shellIntegrationForActiveTerminal(name: string, profile?: string): boolean {
    const hasShellIntegration = activeTerminalShellIntegration();

    if (hasShellIntegration) {
        traceInfo(
            `SHELL: Shell integration is available on your active terminal.  Python activate scripts will be evaluated at shell integration level. 
                Skipping modification of ${name} profile at: ${profile}`,
        );
        return true;
    }
    return false;
}
