import * as fs from 'fs-extra';
import { getUserHomeDir } from '../../../common/utils/pathUtils';
import { isWindows } from '../../../common/utils/platformUtils';

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
                    type: PowerShellProfileType.CurrentUserAllHosts,
                    path: `${home}\\Documents\\WindowsPowerShell\\profile.ps1`,
                },
                {
                    type: PowerShellProfileType.CurrentUserCurrentHost,
                    path: `${home}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`,
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

export async function isPowerShellStartupSetup(): Promise<boolean> {
    const profile = await getPowerShellProfile();
    if (profile) {
        const content = await fs.readFile(profile.path, 'utf8');
        return content.includes(pwshActivationEnvVarKey);
    }
    return false;
}

export async function setupPowerShellStartup(): Promise<void> {
    const lineSep = isWindows() ? '\r\n' : '\n';
    const activationContent = `${lineSep}${lineSep}# VSCODE-PYTHON-ACTIVATION:START${lineSep}if ($env:${pwshActivationEnvVarKey} -ne $null) {${lineSep}    Invoke-Expression $env:${pwshActivationEnvVarKey}${lineSep}}${lineSep}# VSCODE-PYTHON-ACTIVATION:END${lineSep}`;
    const profile = await getPowerShellProfile();
    if (profile) {
        const content = await fs.readFile(profile.path, 'utf8');
        if (!content.includes(pwshActivationEnvVarKey)) {
            await fs.writeFile(profile.path, `${content}${activationContent}`);
        }
    }
}

export async function removePowerShellStartup(): Promise<void> {
    const profile = await getPowerShellProfile();
    if (profile) {
        const content = await fs.readFile(profile.path, 'utf8');
        if (content.includes(pwshActivationEnvVarKey)) {
            const newContent = content.replace(
                new RegExp(`# VSCODE-PYTHON-ACTIVATION:\\s*START.*# VSCODE-PYTHON-ACTIVATION:\\s*END`, 's'),
                '',
            );
            await fs.writeFile(profile.path, newContent);
        }
    }
}
