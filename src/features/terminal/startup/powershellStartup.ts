import * as fs from 'fs-extra';
import { getUserHomeDir } from '../../../common/utils/pathUtils';
import { isWindows } from '../../../common/utils/platformUtils';
import { ShellStartupProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment, TerminalShellType } from '../../../api';
import { getActivationCommandForShell } from '../../common/activation';
import { quoteArgs } from '../../execution/execUtils';
import { traceInfo } from '../../../common/logging';

const pwshActivationEnvVarKey = 'VSCODE_PWSH_ACTIVATE';

enum PowerShellProfileType {
    AllUsersAllHosts = 4,
    AllUsersCurrentHost = 3,
    CurrentUserAllHosts = 2,
    CurrentUserCurrentHost = 1,
}

interface PowerShellProfile {
    type: PowerShellProfileType;
    path: string;
}

function getSearchPaths(): PowerShellProfile[] {
    const profilePaths: PowerShellProfile[] = [];
    const home = getUserHomeDir();
    if (home) {
        if (isWindows()) {
            profilePaths.push(
                {
                    // powershell 5
                    type: PowerShellProfileType.CurrentUserCurrentHost,
                    path: `${home}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`,
                },
                {
                    // powershell 6+
                    type: PowerShellProfileType.CurrentUserCurrentHost,
                    path: `${home}\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1`,
                },
                {
                    // powershell 5
                    type: PowerShellProfileType.CurrentUserAllHosts,
                    path: `${home}\\Documents\\WindowsPowerShell\\profile.ps1`,
                },
                {
                    // powershell 6+
                    type: PowerShellProfileType.CurrentUserAllHosts,
                    path: `${home}\\Documents\\PowerShell\\profile.ps1`,
                },
            );
        } else {
            profilePaths.push(
                {
                    type: PowerShellProfileType.CurrentUserAllHosts,
                    path: `${home}/.config/powershell/profile.ps1`,
                },
                {
                    type: PowerShellProfileType.CurrentUserCurrentHost,
                    path: `${home}.config/powershell/Microsoft.PowerShell_profile.ps1`,
                },
            );
        }
    }

    return profilePaths.sort((a, b) => b.type - a.type);
}

async function getPowerShellProfile(): Promise<PowerShellProfile | undefined> {
    const profiles = getSearchPaths();
    const existingProfiles: PowerShellProfile[] = [];
    await Promise.all(
        profiles.map(async (profile) => {
            if (await fs.pathExists(profile.path)) {
                existingProfiles.push(profile);
            }
        }),
    );
    const containsActivation: PowerShellProfile[] = [];
    await Promise.all(
        existingProfiles.map(async (profile) => {
            const content = await fs.readFile(profile.path, 'utf8');
            if (content.includes(pwshActivationEnvVarKey)) {
                containsActivation.push(profile);
            }
        }),
    );

    if (containsActivation.length > 0) {
        return containsActivation.sort((a, b) => a.type - b.type)[0];
    }
    return existingProfiles.length > 0 ? existingProfiles.sort((a, b) => a.type - b.type)[0] : undefined;
}

const regionStart = '#region vscode python';
const regionEnd = '#endregion vscode python';
function getActivationContent(): string {
    const lineSep = isWindows() ? '\r\n' : '\n';
    const activationContent = `${lineSep}${lineSep}${regionStart}${lineSep}if ($null -ne $env:${pwshActivationEnvVarKey}) {${lineSep}    Invoke-Expression $env:${pwshActivationEnvVarKey}${lineSep}}${lineSep}${regionEnd}${lineSep}`;
    return activationContent;
}

async function isPowerShellStartupSetup(): Promise<boolean> {
    const profile = await getPowerShellProfile();
    if (profile) {
        const content = await fs.readFile(profile.path, 'utf8');
        return content.match(new RegExp(`${regionStart}\\s*.*${regionEnd}\\s*`, 's')) !== null;
    }
    return false;
}

async function setupPowerShellStartup(): Promise<void> {
    const activationContent = getActivationContent();
    const profile = await getPowerShellProfile();
    if (profile) {
        const content = await fs.readFile(profile.path, 'utf8');
        if (!content.includes(pwshActivationEnvVarKey)) {
            await fs.writeFile(profile.path, `${content}${activationContent}`);
        }
    }
    traceInfo(`PowerShell profile setup for activation: ${profile?.path}`);
    traceInfo(activationContent);
    traceInfo(`PowerShell profile setup for activation complete.`);
}

async function removePowerShellStartup(): Promise<void> {
    const profile = await getPowerShellProfile();
    if (profile) {
        const content = await fs.readFile(profile.path, 'utf8');
        if (content.includes(pwshActivationEnvVarKey)) {
            const newContent = content.replace(new RegExp(`${regionStart}\\s*.*${regionEnd}\\s*`, 's'), '');
            await fs.writeFile(profile.path, newContent);
        }
    }
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
    async isSetup(): Promise<boolean> {
        return await isPowerShellStartupSetup();
    }

    async setupScripts(): Promise<void> {
        await setupPowerShellStartup();
    }

    async teardownScripts(): Promise<void> {
        await removePowerShellStartup();
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        const pwshActivation = getActivationCommandForShell(env, TerminalShellType.powershell);

        const curValue = collection.get(pwshActivationEnvVarKey);
        if (curValue) {
            if (pwshActivation) {
                const command = getCommandAsString(pwshActivation);
                if (curValue.value !== command) {
                    collection.replace(pwshActivationEnvVarKey, command, { applyAtProcessCreation: true });
                }
            } else {
                collection.delete(pwshActivationEnvVarKey);
            }
        } else if (pwshActivation) {
            collection.replace(pwshActivationEnvVarKey, getCommandAsString(pwshActivation), {
                applyAtProcessCreation: true,
            });
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(pwshActivationEnvVarKey);
    }

    async getEnvVariables(env: PythonEnvironment): Promise<Map<string, string> | undefined> {
        const pwshActivation = getActivationCommandForShell(env, TerminalShellType.powershell);
        return pwshActivation ? new Map([[pwshActivationEnvVarKey, getCommandAsString(pwshActivation)]]) : undefined;
    }
}
