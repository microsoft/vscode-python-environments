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
        const gitBashPath = path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe');
        return await fs.pathExists(gitBashPath);
    }
    return false;
}

async function getBashProfiles(): Promise<string> {
    const homeDir = os.homedir();
    const profile: string = path.join(homeDir, '.bashrc');

    return profile;
}

async function getZshProfiles(): Promise<string> {
    const homeDir = os.homedir();
    const profile: string = path.join(homeDir, '.zshrc');

    return profile;
}

const regionStart = '# >>> vscode python';
const regionEnd = '# <<< vscode python';

function getActivationContent(key: string): string {
    const lineSep = '\n';

    return ['', '', regionStart, `if [ -n "$${key}" ]; then`, `    eval "$${key}"`, 'fi', regionEnd, ''].join(lineSep);
}

async function isStartupSetup(profile: string, key: string): Promise<ShellSetupState> {
    if (await fs.pathExists(profile)) {
        const content = await fs.readFile(profile, 'utf8');
        return content.includes(key) ? ShellSetupState.Setup : ShellSetupState.NotSetup;
    } else {
        return ShellSetupState.NotSetup;
    }
}

async function setupStartup(profile: string, key: string): Promise<boolean> {
    const activationContent = getActivationContent(key);

    try {
        // Create profile directory if it doesn't exist
        await fs.mkdirp(path.dirname(profile));

        // Create or update profile
        if (!(await fs.pathExists(profile))) {
            // Create new profile with our content
            await fs.writeFile(profile, activationContent);
            traceInfo(`SHELL: Created new profile at: ${profile}\n${activationContent}`);
        } else {
            // Update existing profile
            const content = await fs.readFile(profile, 'utf8');
            if (!content.includes(key)) {
                await fs.writeFile(profile, `${content}${activationContent}`);
                traceInfo(`SHELL: Updated existing profile at: ${profile}\n${activationContent}`);
            } else {
                // Already contains our activation code
                traceInfo(`SHELL: Profile already contains activation code at: ${profile}`);
            }
        }
        return true;
    } catch (err) {
        traceError(`SHELL: Failed to setup startup for profile at: ${profile}`, err);
        return false;
    }
}

async function removeStartup(profile: string, key: string): Promise<boolean> {
    if (!(await fs.pathExists(profile))) {
        return true;
    } // If the file doesn't exist, we're done. No need to remove anything. Return true to indicate success.
    try {
        const content = await fs.readFile(profile, 'utf8');
        if (content.includes(key)) {
            // Use regex to remove the entire region including newlines
            const pattern = new RegExp(`${regionStart}[\\s\\S]*?${regionEnd}\\n?`, 'g');
            const newContent = content.replace(pattern, '');
            await fs.writeFile(profile, newContent);
            traceInfo(`SHELL: Removed activation from profile at: ${profile}`);
        } else {
            traceVerbose(`Profile at ${profile} does not contain activation code`);
        }
        return true;
    } catch (err) {
        traceVerbose(`Failed to remove ${profile} startup`, err);
        return false;
    }
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
    public readonly name: string = 'Bash';
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
            const bashProfile = await getBashProfiles();
            return await isStartupSetup(bashProfile, this.bashActivationEnvVarKey);
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
            const bashProfile = await getBashProfiles();
            const result = await removeStartup(bashProfile, this.bashActivationEnvVarKey);
            return result ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to teardown bash startup scripts', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const bashActivation = getActivationCommandForShell(env, ShellConstants.BASH);
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
            const bashActivation = getActivationCommandForShell(env, ShellConstants.BASH);
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
    public readonly name: string = 'Zsh';
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
            const zshActivation = getActivationCommandForShell(env, ShellConstants.ZSH);
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
            const zshActivation = getActivationCommandForShell(env, ShellConstants.ZSH);
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
    public readonly name: string = 'GitBash';
    private readonly gitBashActivationEnvVarKey = 'VSCODE_BASH_ACTIVATE';

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
            const bashActivation = getActivationCommandForShell(env, ShellConstants.GITBASH);
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
        envVars.delete('VSCODE_GIT_BASH_ACTIVATE');
    }
    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.gitBashActivationEnvVarKey, undefined]]);
        }

        try {
            const zshActivation = getActivationCommandForShell(env, ShellConstants.GITBASH);
            return zshActivation
                ? new Map([[this.gitBashActivationEnvVarKey, getCommandAsString(zshActivation)]])
                : undefined;
        } catch (err) {
            traceError('Failed to get env variables for git bash', err);
            return undefined;
        }
    }
}
