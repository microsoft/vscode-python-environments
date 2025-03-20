import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { ShellScriptEditState, ShellSetupState, ShellStartupProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment, TerminalShellType } from '../../../api';
import { getActivationCommandForShell } from '../../common/activation';
import { quoteArgs } from '../../execution/execUtils';
import { traceError, traceInfo, traceVerbose } from '../../../common/logging';
import which from 'which';

async function isBashLikeInstalled(): Promise<boolean> {
    const result = await Promise.all([which('bash', { nothrow: true }), which('sh', { nothrow: true })]);
    return result.some((r) => r !== null);
}

async function isZshInstalled(): Promise<boolean> {
    const result = await which('zsh', { nothrow: true });
    return result !== null;
}

async function isGitBashInstalled(): Promise<boolean> {
    const gitPath = await which('git', { nothrow: true });
    if (gitPath) {
        const gitBashPath = path.join(path.dirname(gitPath), 'bin', 'bash.exe');
        return await fs.pathExists(gitBashPath);
    }
    return false;
}

async function getBashProfiles(): Promise<string[]> {
    const homeDir = os.homedir();
    const profiles: string[] = [path.join(homeDir, '.bashrc'), path.join(homeDir, '.bash_profile')];

    // Filter to only existing profiles or the first one if none exist
    const existingProfiles = await Promise.all(
        profiles.map(async (profile) => ({
            profilePath: profile,
            exists: await fs.pathExists(profile),
        })),
    );

    const result = existingProfiles.filter((p) => p.exists);
    if (result.length === 0) {
        // If no profile exists, return the first one so we can create it
        return [profiles[0]];
    }

    return result.map((p) => p.profilePath);
}

async function getZshProfiles(): Promise<string[]> {
    const homeDir = os.homedir();
    const profiles: string[] = [path.join(homeDir, '.zshrc')];

    // Filter to only existing profiles or the first one if none exist
    const existingProfiles = await Promise.all(
        profiles.map(async (profile) => ({
            profilePath: profile,
            exists: await fs.pathExists(profile),
        })),
    );

    const result = existingProfiles.filter((p) => p.exists);
    if (result.length === 0) {
        // If no profile exists, return the first one so we can create it
        return [profiles[0]];
    }

    return result.map((p) => p.profilePath);
}

const regionStart = '# >>> vscode python';
const regionEnd = '# <<< vscode python';

function getActivationContent(key: string): string {
    const lineSep = '\n';

    return ['', '', regionStart, `if [ -n "$${key}" ]; then`, `    eval "$${key}"`, 'fi', regionEnd, ''].join(lineSep);
}

async function isStartupSetup(profiles: string[], key: string): Promise<ShellSetupState> {
    if (profiles.length === 0) {
        return ShellSetupState.NotSetup;
    }

    // Check if any profile has our activation content
    const results = await Promise.all(
        profiles.map(async (profile) => {
            if (await fs.pathExists(profile)) {
                const content = await fs.readFile(profile, 'utf8');
                if (content.includes(key)) {
                    return true;
                }
            }
            return false;
        }),
    );

    return results.some((result) => result) ? ShellSetupState.Setup : ShellSetupState.NotSetup;
}

async function setupStartup(profiles: string[], key: string): Promise<boolean> {
    if (profiles.length === 0) {
        traceVerbose('Cannot setup Bash startup - No profiles found');
        return false;
    }

    const activationContent = getActivationContent(key);
    let successfulUpdates = 0;

    for (const profile of profiles) {
        try {
            // Create profile directory if it doesn't exist
            await fs.mkdirp(path.dirname(profile));

            // Create or update profile
            if (!(await fs.pathExists(profile))) {
                // Create new profile with our content
                await fs.writeFile(profile, activationContent);
                traceInfo(`Created new profile at: ${profile}\n${activationContent}`);
                successfulUpdates++;
            } else {
                // Update existing profile
                const content = await fs.readFile(profile, 'utf8');
                if (!content.includes(key)) {
                    await fs.writeFile(profile, `${content}${activationContent}`);
                    traceInfo(`Updated existing profile at: ${profile}\n${activationContent}`);
                    successfulUpdates++;
                } else {
                    // Already contains our activation code
                    successfulUpdates++;
                }
            }
        } catch (err) {
            traceVerbose(`Failed to setup ${profile} startup`, err);
        }
    }

    // Return true only if all profiles were successfully updated
    return profiles.length > 0 && successfulUpdates === profiles.length;
}

async function removeStartup(profiles: string[], key: string): Promise<boolean> {
    let successfulRemovals = 0;

    for (const profile of profiles) {
        if (!(await fs.pathExists(profile))) {
            successfulRemovals++; // Count as success if file doesn't exist since there's nothing to remove
            continue;
        }

        try {
            const content = await fs.readFile(profile, 'utf8');
            if (content.includes(key)) {
                // Use regex to remove the entire region including newlines
                const pattern = new RegExp(`${regionStart}[\\s\\S]*?${regionEnd}\\n?`, 'g');
                const newContent = content.replace(pattern, '');
                await fs.writeFile(profile, newContent);
                traceInfo(`Removed activation from profile at: ${profile}`);
                successfulRemovals++;
            } else {
                successfulRemovals++; // Count as success if activation is not present
            }
        } catch (err) {
            traceVerbose(`Failed to remove ${profile} startup`, err);
        }
    }

    // Return true only if all profiles were successfully processed
    return profiles.length > 0 && successfulRemovals === profiles.length;
}

function getCommandAsString(command: PythonCommandRunConfiguration[]): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        // For bash, we need to ensure proper quoting
        parts.push(quoteArgs([cmd.executable, ...args]).join(' '));
    }
    return parts.join(' && ');
}

export class BashStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'sh|bash';
    private readonly bashActivationEnvVarKey = 'VSCODE_BASH_ACTIVATE';

    private async checkShellInstalled(): Promise<boolean> {
        const found = await isBashLikeInstalled();
        if (!found) {
            traceInfo(
                '`bash` or `sh` was not found on the system',
                'If it is installed make sure it is available on `PATH`',
            );
        }
        return found;
    }

    async isSetup(): Promise<ShellSetupState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellSetupState.NotInstalled;
        }

        try {
            const bashProfiles = await getBashProfiles();
            return await isStartupSetup(bashProfiles, this.bashActivationEnvVarKey);
        } catch (err) {
            traceError('Failed to check bash startup scripts', err);
            return ShellSetupState.NotSetup;
        }
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const bashProfiles = await getBashProfiles();
            const result = await setupStartup(bashProfiles, this.bashActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup bash startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const bashProfiles = await getBashProfiles();
            const result = await removeStartup(bashProfiles, this.bashActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to teardown bash startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const bashActivation = getActivationCommandForShell(env, TerminalShellType.bash);
            if (bashActivation) {
                const command = getCommandAsString(bashActivation);
                collection.replace(this.bashActivationEnvVarKey, command);
            } else {
                collection.delete(this.bashActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update env variables for bash', err);
            collection.delete(this.bashActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(this.bashActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.bashActivationEnvVarKey, undefined]]);
        }

        try {
            const bashActivation = getActivationCommandForShell(env, TerminalShellType.bash);
            return bashActivation
                ? new Map([[this.bashActivationEnvVarKey, getCommandAsString(bashActivation)]])
                : undefined;
        } catch (err) {
            traceError('Failed to get env variables for bash', err);
            return undefined;
        }
    }
}

export class ZshStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'zsh';
    private readonly zshActivationEnvVarKey = 'VSCODE_ZSH_ACTIVATE';

    private async checkShellInstalled(): Promise<boolean> {
        const found = await isZshInstalled();
        if (!found) {
            traceInfo('`zsh` was not found on the system', 'If it is installed make sure it is available on `PATH`');
        }
        return found;
    }

    async isSetup(): Promise<ShellSetupState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellSetupState.NotInstalled;
        }

        try {
            const zshProfiles = await getZshProfiles();
            return await isStartupSetup(zshProfiles, this.zshActivationEnvVarKey);
        } catch (err) {
            traceError('Failed to check zsh startup scripts', err);
            return ShellSetupState.NotSetup;
        }
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellScriptEditState.NotInstalled;
        }
        try {
            const zshProfiles = await getZshProfiles();
            const result = await setupStartup(zshProfiles, this.zshActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup zsh startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellScriptEditState.NotInstalled;
        }
        try {
            const zshProfiles = await getZshProfiles();
            const result = await removeStartup(zshProfiles, this.zshActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to teardown zsh startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const zshActivation = getActivationCommandForShell(env, TerminalShellType.zsh);
            if (zshActivation) {
                const command = getCommandAsString(zshActivation);
                envVars.replace(this.zshActivationEnvVarKey, command);
            } else {
                envVars.delete(this.zshActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update env variables for zsh', err);
            envVars.delete(this.zshActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void> {
        envVars.delete(this.zshActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.zshActivationEnvVarKey, undefined]]);
        }

        try {
            const zshActivation = getActivationCommandForShell(env, TerminalShellType.zsh);
            return zshActivation
                ? new Map([[this.zshActivationEnvVarKey, getCommandAsString(zshActivation)]])
                : undefined;
        } catch (err) {
            traceError('Failed to get env variables for zsh', err);
            return undefined;
        }
    }
}

export class GitBashStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'git-bash';
    private readonly gitBashActivationEnvVarKey = 'VSCODE_GIT_BASH_ACTIVATE';

    private async checkShellInstalled(): Promise<boolean> {
        const found = await isGitBashInstalled();
        if (!found) {
            traceInfo('Git Bash was not found on the system', 'If it is installed make sure it is available on `PATH`');
        }
        return found;
    }

    async isSetup(): Promise<ShellSetupState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellSetupState.NotInstalled;
        }
        try {
            const bashProfiles = await getBashProfiles();
            return await isStartupSetup(bashProfiles, this.gitBashActivationEnvVarKey);
        } catch (err) {
            traceError('Failed to check git bash startup scripts', err);
            return ShellSetupState.NotSetup;
        }
    }
    async setupScripts(): Promise<ShellScriptEditState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const bashProfiles = await getBashProfiles();
            const result = await setupStartup(bashProfiles, this.gitBashActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup git bash startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }
    async teardownScripts(): Promise<ShellScriptEditState> {
        const found = await this.checkShellInstalled();
        if (!found) {
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const bashProfiles = await getBashProfiles();
            const result = await removeStartup(bashProfiles, this.gitBashActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to teardown git bash startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }
    async updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const bashActivation = getActivationCommandForShell(env, TerminalShellType.gitbash);
            if (bashActivation) {
                const command = getCommandAsString(bashActivation);
                envVars.replace(this.gitBashActivationEnvVarKey, command);
            } else {
                envVars.delete(this.gitBashActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update env variables for git bash', err);
            envVars.delete(this.gitBashActivationEnvVarKey);
        }
    }
    async removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void> {
        envVars.delete(this.gitBashActivationEnvVarKey);
    }
    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.gitBashActivationEnvVarKey, undefined]]);
        }

        try {
            const zshActivation = getActivationCommandForShell(env, TerminalShellType.zsh);
            return zshActivation
                ? new Map([[this.gitBashActivationEnvVarKey, getCommandAsString(zshActivation)]])
                : undefined;
        } catch (err) {
            traceError('Failed to get env variables for git bash', err);
            return undefined;
        }
    }
}
