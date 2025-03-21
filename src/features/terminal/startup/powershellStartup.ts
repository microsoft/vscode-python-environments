import * as fs from 'fs-extra';
import * as path from 'path';
import { isWindows } from '../../../common/utils/platformUtils';
import { ShellScriptEditState, ShellSetupState, ShellStartupProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../api';
import { getActivationCommandForShell } from '../../common/activation';
import { traceError, traceInfo, traceVerbose } from '../../../common/logging';
import { getCommandAsString, runCommand } from './utils';
import which from 'which';
import { ShellConstants } from '../../common/shellConstants';

async function isPowerShellInstalled(): Promise<boolean> {
    const result = await Promise.all([which('powershell', { nothrow: true }), which('pwsh', { nothrow: true })]);
    return result.some((r) => r !== null);
}
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
    try {
        const profilePath = await runCommand(`${shell} -Command $profile`);
        if (!profilePath) {
            traceVerbose(`${shell} is not available or failed to get profile path`);
            return undefined;
        }
        return { shell, profilePath };
    } catch (err) {
        traceVerbose(`${shell} is not available or failed to get profile path`, err);
        return undefined;
    }
}

const regionStart = '#region vscode python';
const regionEnd = '#endregion vscode python';
function getActivationContent(key: string): string {
    const lineSep = isWindows() ? '\r\n' : '\n';
    const activationContent = [
        '',
        '',
        regionStart,
        `if ($null -ne $env:${key}) {`,
        `    Invoke-Expression $env:${key}`,
        '}',
        regionEnd,
        '',
    ].join(lineSep);
    return activationContent;
}

async function isPowerShellStartupSetup(key: string): Promise<boolean> {
    const profiles = await getPowerShellProfiles();
    if (profiles.length === 0) {
        return false;
    }

    // Check if any profile has our activation content
    const results = await Promise.all(
        profiles.map(async (profile) => {
            if (await fs.pathExists(profile.profilePath)) {
                const content = await fs.readFile(profile.profilePath, 'utf8');
                if (content.includes(key)) {
                    return true;
                }
            }
            return false;
        }),
    );

    return results.some((result) => result);
}

async function setupPowerShellStartup(key: string): Promise<boolean> {
    const profiles = await getPowerShellProfiles();
    if (profiles.length === 0) {
        traceVerbose('Cannot setup PowerShell startup - No PowerShell versions available');
        return false;
    }

    const activationContent = getActivationContent(key);
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
                if (!content.includes(key)) {
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

async function removePowerShellStartup(key: string): Promise<boolean> {
    const profiles = await getPowerShellProfiles();
    let successfulRemovals = 0;

    for (const profile of profiles) {
        if (!(await fs.pathExists(profile.profilePath))) {
            successfulRemovals++; // Count as success if file doesn't exist since there's nothing to remove
            continue;
        }

        try {
            const content = await fs.readFile(profile.profilePath, 'utf8');
            if (content.includes(key)) {
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

export class PwshStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'PowerShell';
    private readonly pwshActivationEnvVarKey = 'VSCODE_PWSH_ACTIVATE';

    async isSetup(): Promise<ShellSetupState> {
        const isInstalled = await isPowerShellInstalled();
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellSetupState.NotInstalled;
        }

        try {
            const isSetup = await isPowerShellStartupSetup(this.pwshActivationEnvVarKey);
            return isSetup ? ShellSetupState.Setup : ShellSetupState.NotSetup;
        } catch (err) {
            traceError('Failed to check if PowerShell startup is setup', err);
            return ShellSetupState.NotSetup;
        }
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isPowerShellInstalled();
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const success = await setupPowerShellStartup(this.pwshActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup PowerShell startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isPowerShellInstalled();
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const success = await removePowerShellStartup(this.pwshActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to remove PowerShell startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const pwshActivation = getActivationCommandForShell(env, ShellConstants.PWSH);
            if (pwshActivation) {
                const command = getCommandAsString(pwshActivation, '&&');
                collection.replace(this.pwshActivationEnvVarKey, command);
            } else {
                collection.delete(this.pwshActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update PowerShell environment variables', err);
            collection.delete(this.pwshActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(this.pwshActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.pwshActivationEnvVarKey, undefined]]);
        }

        try {
            const pwshActivation = getActivationCommandForShell(env, ShellConstants.PWSH);
            return pwshActivation
                ? new Map([[this.pwshActivationEnvVarKey, getCommandAsString(pwshActivation, '&&')]])
                : undefined;
        } catch (err) {
            traceError('Failed to get PowerShell environment variables', err);
            return undefined;
        }
    }
}
