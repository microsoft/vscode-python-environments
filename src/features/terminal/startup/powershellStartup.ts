import * as fs from 'fs-extra';
import * as path from 'path';
import { isWindows } from '../../../common/utils/platformUtils';
import { ShellStartupProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment, TerminalShellType } from '../../../api';
import { getActivationCommandForShell } from '../../common/activation';
import { quoteArgs } from '../../execution/execUtils';
import { traceInfo, traceVerbose } from '../../../common/logging';
import { runCommand } from './utils';

const pwshActivationEnvVarKey = 'VSCODE_PWSH_ACTIVATE';

interface PowerShellInfo {
    shell: 'powershell' | 'pwsh';
    profilePath: string;
}

async function getPowerShellProfiles(): Promise<PowerShellInfo[]> {
    // Try to get profiles from both shells in parallel
    const results = await Promise.all([getProfileForShell('pwsh'), getProfileForShell('powershell')]);

    return results.filter((result): result is PowerShellInfo => result !== undefined);
}

async function getProfileForShell(shell: 'powershell' | 'pwsh'): Promise<PowerShellInfo | undefined> {
    const profilePath = await runCommand(`${shell} -Command $profile`);
    if (!profilePath) {
        traceVerbose(`${shell} is not available or failed to get profile path`);
        return undefined;
    }
    return { shell, profilePath };
}

const regionStart = '#region vscode python';
const regionEnd = '#endregion vscode python';
function getActivationContent(): string {
    const lineSep = isWindows() ? '\r\n' : '\n';
    const activationContent = `${lineSep}${lineSep}${regionStart}${lineSep}if ($null -ne $env:${pwshActivationEnvVarKey}) {${lineSep}    Invoke-Expression $env:${pwshActivationEnvVarKey}${lineSep}}${lineSep}${regionEnd}${lineSep}`;
    return activationContent;
}

async function isPowerShellStartupSetup(): Promise<boolean> {
    const profiles = await getPowerShellProfiles();
    if (profiles.length === 0) {
        return false;
    }

    // Check if any profile has our activation content
    for (const profile of profiles) {
        if (!(await fs.pathExists(profile.profilePath))) {
            continue;
        }

        const content = await fs.readFile(profile.profilePath, 'utf8');
        if (content.includes(pwshActivationEnvVarKey)) {
            return true;
        }
    }

    return false;
}

async function setupPowerShellStartup(): Promise<boolean> {
    const profiles = await getPowerShellProfiles();
    if (profiles.length === 0) {
        traceVerbose('Cannot setup PowerShell startup - No PowerShell versions available');
        return false;
    }

    const activationContent = getActivationContent();
    let successfulUpdates = 0;

    for (const profile of profiles) {
        try {
            // Create profile directory if it doesn't exist
            await fs.mkdirp(path.dirname(profile.profilePath));

            // Create or update profile
            if (!(await fs.pathExists(profile.profilePath))) {
                // Create new profile with our content
                await fs.writeFile(profile.profilePath, activationContent);
                traceInfo(`Created new ${profile.shell} profile at: ${profile.profilePath}\r\n${activationContent}`);
                successfulUpdates++;
            } else {
                // Update existing profile
                const content = await fs.readFile(profile.profilePath, 'utf8');
                if (!content.includes(pwshActivationEnvVarKey)) {
                    await fs.writeFile(profile.profilePath, `${content}${activationContent}`);
                    traceInfo(
                        `Updated existing ${profile.shell} profile at: ${profile.profilePath}\r\n${activationContent}`,
                    );
                    successfulUpdates++;
                }
            }
        } catch (err) {
            traceVerbose(`Failed to setup ${profile.shell} startup`, err);
        }
    }

    return successfulUpdates === profiles.length;
}

async function removePowerShellStartup(): Promise<boolean> {
    const profiles = await getPowerShellProfiles();
    let successfulRemovals = 0;

    for (const profile of profiles) {
        if (!(await fs.pathExists(profile.profilePath))) {
            successfulRemovals++; // Count as success if file doesn't exist since there's nothing to remove
            continue;
        }

        try {
            const content = await fs.readFile(profile.profilePath, 'utf8');
            if (content.includes(pwshActivationEnvVarKey)) {
                const newContent = content.replace(new RegExp(`${regionStart}\\s*.*${regionEnd}\\s*`, 's'), '');
                await fs.writeFile(profile.profilePath, newContent);
                traceInfo(`Removed activation from ${profile.shell} profile at: ${profile.profilePath}`);
                successfulRemovals++;
            } else {
                successfulRemovals++; // Count as success if activation is not present since there's nothing to remove
            }
        } catch (err) {
            traceVerbose(`Failed to remove ${profile.shell} startup`, err);
        }
    }

    return profiles.length > 0 && successfulRemovals === profiles.length;
}

function getCommandAsString(command: PythonCommandRunConfiguration[]): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        parts.push(quoteArgs([cmd.executable, ...args]).join(' '));
    }
    return parts.join(' && ');
}

export class PowershellStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'PowerShell';
    async isSetup(): Promise<boolean> {
        return await isPowerShellStartupSetup();
    }

    async setupScripts(): Promise<boolean> {
        return await setupPowerShellStartup();
    }

    async teardownScripts(): Promise<boolean> {
        return await removePowerShellStartup();
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        const pwshActivation = getActivationCommandForShell(env, TerminalShellType.powershell);
        if (pwshActivation) {
            const command = getCommandAsString(pwshActivation);
            collection.replace(pwshActivationEnvVarKey, command);
        } else {
            collection.delete(pwshActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(pwshActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (env) {
            const pwshActivation = getActivationCommandForShell(env, TerminalShellType.powershell);
            return pwshActivation
                ? new Map([[pwshActivationEnvVarKey, getCommandAsString(pwshActivation)]])
                : undefined;
        } else {
            return new Map([[pwshActivationEnvVarKey, undefined]]);
        }
    }
}
