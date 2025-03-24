import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { ShellScriptEditState, ShellSetupState, ShellStartupProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment } from '../../../api';
import { getActivationCommandForShell } from '../../common/activation';
import { quoteArgs } from '../../execution/execUtils';
import { traceError, traceInfo, traceVerbose } from '../../../common/logging';
import which from 'which';
import { ShellConstants } from '../../common/shellConstants';
import { runCommand } from './utils';
import { isWindows } from '../../../common/utils/platformUtils';

async function isNuShellInstalled(): Promise<boolean> {
    try {
        const binPath = await which('nu');
        traceInfo(`SHELL: Nu shell binary found at ${binPath}`);
        return true;
    } catch {
        return false;
    }
}

async function getDefaultConfigPath(): Promise<string | undefined> {
    try {
        const configPath = await runCommand('nu -c $nu.default-config-dir');

        return configPath ? configPath.trim() : undefined;
    } catch (err) {
        traceError(`Failed to get default config path`, err);
        return undefined;
    }
}

async function getNuShellProfile(): Promise<string> {
    const pathsToCheck: string[] = [];

    const defaultConfigPath = await getDefaultConfigPath();
    if (defaultConfigPath) {
        pathsToCheck.push(path.join(defaultConfigPath, 'config.nu'));
    }

    if (isWindows()) {
        const appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        pathsToCheck.push(path.join(appDataPath, 'nushell', 'config.nu'), path.join(appDataPath, 'nu', 'config.nu'));
    }

    pathsToCheck.push(
        path.join(os.homedir(), '.config', 'nushell', 'config.nu'),
        path.join(os.homedir(), '.config', 'nu', 'config.nu'),
        path.join(os.homedir(), '.nushell', 'config.nu'),
        path.join(os.homedir(), '.nu', 'config.nu'),
    );

    for (const profilePath of pathsToCheck) {
        if (await fs.pathExists(profilePath)) {
            traceInfo(`SHELL: Nu shell profile found at ${profilePath}`);
            return profilePath;
        }
    }

    // Nothing worked so return the default path
    if (isWindows()) {
        const defaultPath = path.join(os.homedir(), 'AppData', 'Roaming', 'nushell', 'config.nu');
        traceInfo(`SHELL: Nu shell profile not found, using default path ${defaultPath}`);
        return defaultPath;
    }

    const defaultPath = path.join(os.homedir(), '.config', 'nushell', 'config.nu');
    traceInfo(`SHELL: Nu shell profile not found, using default path ${defaultPath}`);
    return defaultPath;
}

const regionStart = '# >>> vscode python';
const regionEnd = '# <<< vscode python';

function getActivationContent(key: string): string {
    const lineSep = '\n';
    // In Nu shell, environment variables are checked with `if` statement and executed with `do`
    return [
        '',
        '',
        regionStart,
        `if (env | where name == "${key}" | is-empty | not)`,
        `    do $env.${key}`,
        'end',
        regionEnd,
        '',
    ].join(lineSep);
}

async function isStartupSetup(profilePath: string, key: string): Promise<boolean> {
    if (!(await fs.pathExists(profilePath))) {
        return false;
    }

    // Check if profile has our activation content
    const content = await fs.readFile(profilePath, 'utf8');
    return content.includes(key);
}

async function setupStartup(profilePath: string, key: string): Promise<boolean> {
    try {
        const activationContent = getActivationContent(key);

        // Create profile directory if it doesn't exist
        await fs.mkdirp(path.dirname(profilePath));

        // Create or update profile
        if (!(await fs.pathExists(profilePath))) {
            // Create new profile with our content
            await fs.writeFile(profilePath, activationContent);
            traceInfo(`Created new Nu shell profile at: ${profilePath}\n${activationContent}`);
        } else {
            // Update existing profile
            const content = await fs.readFile(profilePath, 'utf8');
            if (!content.includes(key)) {
                await fs.writeFile(profilePath, `${content}${activationContent}`);
                traceInfo(`Updated existing Nu shell profile at: ${profilePath}\n${activationContent}`);
            } else {
                // Already contains our activation code
                traceInfo(`Nu shell profile at ${profilePath} already contains activation code`);
            }
        }
        return true;
    } catch (err) {
        traceVerbose(`Failed to setup Nu shell startup`, err);
        return false;
    }
}

async function removeNuShellStartup(profilePath: string, key: string): Promise<boolean> {
    if (!(await fs.pathExists(profilePath))) {
        return true; // Count as success if file doesn't exist since there's nothing to remove
    }

    try {
        const content = await fs.readFile(profilePath, 'utf8');
        if (content.includes(key)) {
            // Use regex to remove the entire region including newlines
            const pattern = new RegExp(`${regionStart}[\\s\\S]*?${regionEnd}\\n?`, 'g');
            const newContent = content.replace(pattern, '');
            await fs.writeFile(profilePath, newContent);
            traceInfo(`Removed activation from Nu shell profile at: ${profilePath}`);
        }
        return true;
    } catch (err) {
        traceVerbose(`Failed to remove Nu shell startup`, err);
        return false;
    }
}

function getCommandAsString(command: PythonCommandRunConfiguration[]): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        // For Nu shell, we need to ensure proper quoting
        parts.push(quoteArgs([cmd.executable, ...args]).join(' '));
    }
    // In Nu shell, commands are chained with `;` followed by a space
    return parts.join('; ');
}

export class NuShellStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'nushell';
    public readonly nuShellActivationEnvVarKey = 'VSCODE_NU_ACTIVATE';

    async isSetup(): Promise<ShellSetupState> {
        const isInstalled = await isNuShellInstalled();
        if (!isInstalled) {
            traceVerbose('Nu shell is not installed');
            return ShellSetupState.NotInstalled;
        }

        try {
            const nuShellProfile = await getNuShellProfile();
            const isSetup = await isStartupSetup(nuShellProfile, this.nuShellActivationEnvVarKey);
            return isSetup ? ShellSetupState.Setup : ShellSetupState.NotSetup;
        } catch (err) {
            traceError('Failed to check if Nu shell startup is setup', err);
            return ShellSetupState.NotSetup;
        }
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isNuShellInstalled();
        if (!isInstalled) {
            traceVerbose('Nu shell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const nuShellProfile = await getNuShellProfile();
            const success = await setupStartup(nuShellProfile, this.nuShellActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup Nu shell startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isNuShellInstalled();
        if (!isInstalled) {
            traceVerbose('Nu shell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const nuShellProfile = await getNuShellProfile();
            const success = await removeNuShellStartup(nuShellProfile, this.nuShellActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to remove Nu shell startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const nuShellActivation = getActivationCommandForShell(env, ShellConstants.NU);
            if (nuShellActivation) {
                const command = getCommandAsString(nuShellActivation);
                collection.replace(this.nuShellActivationEnvVarKey, command);
            } else {
                collection.delete(this.nuShellActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update Nu shell environment variables', err);
            collection.delete(this.nuShellActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(this.nuShellActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.nuShellActivationEnvVarKey, undefined]]);
        }

        try {
            const nuShellActivation = getActivationCommandForShell(env, ShellConstants.NU);
            return nuShellActivation
                ? new Map([[this.nuShellActivationEnvVarKey, getCommandAsString(nuShellActivation)]])
                : undefined;
        } catch (err) {
            traceError('Failed to get Nu shell environment variables', err);
            return undefined;
        }
    }
}
