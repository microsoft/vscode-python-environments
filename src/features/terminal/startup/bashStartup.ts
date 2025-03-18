import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { ShellStartupProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment, TerminalShellType } from '../../../api';
import { getActivationCommandForShell } from '../../common/activation';
import { quoteArgs } from '../../execution/execUtils';
import { traceInfo, traceVerbose } from '../../../common/logging';

const bashActivationEnvVarKey = 'VSCODE_BASH_ACTIVATE';

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

function getActivationContent(): string {
    const lineSep = '\n';
    return `${lineSep}${lineSep}${regionStart}${lineSep}if [ -n "$${bashActivationEnvVarKey}" ]; then${lineSep}    eval "$${bashActivationEnvVarKey}"${lineSep}fi${lineSep}${regionEnd}${lineSep}`;
}

async function isStartupSetup(profiles: string[]): Promise<boolean> {
    if (profiles.length === 0) {
        return false;
    }

    // Check if any profile has our activation content
    const results = await Promise.all(
        profiles.map(async (profile) => {
            if (await fs.pathExists(profile)) {
                const content = await fs.readFile(profile, 'utf8');
                if (content.includes(bashActivationEnvVarKey)) {
                    return true;
                }
            }
            return false;
        }),
    );

    return results.some((result) => result);
}

async function setupStartup(profiles: string[]): Promise<boolean> {
    if (profiles.length === 0) {
        traceVerbose('Cannot setup Bash startup - No profiles found');
        return false;
    }

    const activationContent = getActivationContent();
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
                if (!content.includes(bashActivationEnvVarKey)) {
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

async function removeBashStartup(profiles: string[]): Promise<boolean> {
    let successfulRemovals = 0;

    for (const profile of profiles) {
        if (!(await fs.pathExists(profile))) {
            successfulRemovals++; // Count as success if file doesn't exist since there's nothing to remove
            continue;
        }

        try {
            const content = await fs.readFile(profile, 'utf8');
            if (content.includes(bashActivationEnvVarKey)) {
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
    public readonly name: string = 'sh|bash|zsh';

    async isSetup(): Promise<boolean> {
        const bashProfiles = await getBashProfiles();
        const zshProfiles = await getZshProfiles();
        const result = await Promise.all([isStartupSetup(bashProfiles), isStartupSetup(zshProfiles)]);
        return result.every((res) => res);
    }

    async setupScripts(): Promise<boolean> {
        const bashProfiles = await getBashProfiles();
        const zshProfiles = await getZshProfiles();
        const result = await Promise.all([setupStartup(bashProfiles), setupStartup(zshProfiles)]);
        return result.every((res) => res);
    }

    async teardownScripts(): Promise<boolean> {
        const bashProfiles = await getBashProfiles();
        const zshProfiles = await getZshProfiles();
        const result = await Promise.all([removeBashStartup(bashProfiles), removeBashStartup(zshProfiles)]);
        return result.every((res) => res);
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        const bashActivation = getActivationCommandForShell(env, TerminalShellType.bash);
        if (bashActivation) {
            const command = getCommandAsString(bashActivation);
            collection.replace(bashActivationEnvVarKey, command);
        } else {
            collection.delete(bashActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(bashActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (env) {
            const bashActivation = getActivationCommandForShell(env, TerminalShellType.bash);
            return bashActivation
                ? new Map([[bashActivationEnvVarKey, getCommandAsString(bashActivation)]])
                : undefined;
        } else {
            return new Map([[bashActivationEnvVarKey, undefined]]);
        }
    }
}

export class GitBashStartupProvider implements ShellStartupProvider {
    async isSetup(): Promise<boolean> {
        const bashProfiles = await getBashProfiles();
        return await isStartupSetup(bashProfiles);
    }
    async setupScripts(): Promise<boolean> {
        const bashProfiles = await getBashProfiles();
        return await setupStartup(bashProfiles);
    }
    async teardownScripts(): Promise<boolean> {
        const bashProfiles = await getBashProfiles();
        return await removeBashStartup(bashProfiles);
    }
    async updateEnvVariables(envVars: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        const bashActivation = getActivationCommandForShell(env, TerminalShellType.gitbash);
        if (bashActivation) {
            const command = getCommandAsString(bashActivation);
            envVars.replace(bashActivationEnvVarKey, command);
        } else {
            envVars.delete(bashActivationEnvVarKey);
        }
    }
    async removeEnvVariables(envVars: EnvironmentVariableCollection): Promise<void> {
        envVars.delete(bashActivationEnvVarKey);
    }
    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (env) {
            const bashActivation = getActivationCommandForShell(env, TerminalShellType.gitbash);
            return bashActivation
                ? new Map([[bashActivationEnvVarKey, getCommandAsString(bashActivation)]])
                : undefined;
        } else {
            return new Map([[bashActivationEnvVarKey, undefined]]);
        }
    }
    public readonly name: string = 'git-bash';
}
