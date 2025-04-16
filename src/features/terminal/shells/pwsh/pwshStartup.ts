import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import which from 'which';
import { traceError, traceInfo, traceVerbose } from '../../../../common/logging';
import { isWindows } from '../../../../common/utils/platformUtils';
import { ShellScriptEditState, ShellSetupState, ShellStartupScriptProvider } from '../startupProvider';
import { runCommand } from '../utils';

import { ShellConstants } from '../../../common/shellConstants';
import { hasStartupCode, insertStartupCode, removeStartupCode } from '../common/editUtils';
import { POWERSHELL_ENV_KEY } from './pwshConstants';

async function isPowerShellInstalled(shell: string): Promise<boolean> {
    try {
        await which(shell);
        return true;
    } catch {
        traceVerbose(`${shell} is not installed`);
        return false;
    }
}

async function getProfileForShell(shell: 'powershell' | 'pwsh'): Promise<string> {
    try {
        const profilePath = await runCommand(
            isWindows() ? `${shell} -Command $profile` : `${shell} -Command \\$profile`,
        );
        traceInfo(`SHELL: ${shell} profile found at: ${profilePath}`);

        if (profilePath) {
            return profilePath.trim();
        }
    } catch (err) {
        traceError(`${shell} failed to get profile path`, err);
    }

    let profile: string;
    if (isWindows()) {
        if (shell === 'powershell') {
            profile = path.join(
                process.env.USERPROFILE || os.homedir(),
                'Documents',
                'WindowsPowerShell',
                'Microsoft.PowerShell_profile.ps1',
            );
        } else {
            profile = path.join(
                process.env.USERPROFILE || os.homedir(),
                'Documents',
                'PowerShell',
                'Microsoft.PowerShell_profile.ps1',
            );
        }
    } else {
        profile = path.join(
            process.env.HOME || os.homedir(),
            '.config',
            'powershell',
            'Microsoft.PowerShell_profile.ps1',
        );
    }
    traceInfo(`SHELL: ${shell} profile not found, using default path: ${profile}`);
    return profile;
}

const regionStart = '#region vscode python';
const regionEnd = '#endregion vscode python';
function getActivationContent(): string {
    const lineSep = isWindows() ? '\r\n' : '\n';
    const activationContent = [
        `if (($env:TERM_PROGRAM -eq 'vscode') -and ($null -ne $env:${POWERSHELL_ENV_KEY})) {`,
        `    Invoke-Expression $env:${POWERSHELL_ENV_KEY}`,
        '}',
    ].join(lineSep);
    return activationContent;
}

async function isPowerShellStartupSetup(shell: string, profile: string): Promise<boolean> {
    if (await fs.pathExists(profile)) {
        const content = await fs.readFile(profile, 'utf8');
        if (hasStartupCode(content, regionStart, regionEnd, [POWERSHELL_ENV_KEY])) {
            traceInfo(`SHELL: ${shell} already contains activation code: ${profile}`);
            return true;
        }
    }
    traceInfo(`SHELL: ${shell} does not contain activation code: ${profile}`);
    return false;
}

async function setupPowerShellStartup(shell: string, profile: string): Promise<boolean> {
    const activationContent = getActivationContent();

    try {
        if (await fs.pathExists(profile)) {
            const content = await fs.readFile(profile, 'utf8');
            if (hasStartupCode(content, regionStart, regionEnd, [POWERSHELL_ENV_KEY])) {
                traceInfo(`SHELL: ${shell} already contains activation code: ${profile}`);
            } else {
                await fs.writeFile(profile, insertStartupCode(content, regionStart, regionEnd, activationContent));
                traceInfo(`SHELL: Updated existing ${shell} profile at: ${profile}\r\n${activationContent}`);
            }
        } else {
            await fs.mkdirp(path.dirname(profile));
            await fs.writeFile(profile, insertStartupCode('', regionStart, regionEnd, activationContent));
            traceInfo(`SHELL: Created new ${shell} profile at: ${profile}\r\n${activationContent}`);
        }
        return true;
    } catch (err) {
        traceError(`Failed to setup ${shell} startup`, err);
        return false;
    }
}

async function removePowerShellStartup(shell: string, profile: string): Promise<boolean> {
    if (!(await fs.pathExists(profile))) {
        return true;
    }

    try {
        const content = await fs.readFile(profile, 'utf8');
        if (hasStartupCode(content, regionStart, regionEnd, [POWERSHELL_ENV_KEY])) {
            await fs.writeFile(profile, removeStartupCode(content, regionStart, regionEnd));
            traceInfo(`SHELL: Removed activation from ${shell} profile at: ${profile}`);
        } else {
            traceInfo(`SHELL: No activation code found in ${shell} profile at: ${profile}`);
        }
        return true;
    } catch (err) {
        traceError(`SHELL: Failed to remove startup code for ${shell} profile at: ${profile}`, err);
        return false;
    }
}

export class PowerShellClassicStartupProvider implements ShellStartupScriptProvider {
    public readonly name: string = 'PowerShell5';
    public readonly shellType: string = 'powershell';

    async isSetup(): Promise<ShellSetupState> {
        const isInstalled = await isPowerShellInstalled('powershell');
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellSetupState.NotInstalled;
        }

        try {
            const profile = await getProfileForShell('powershell');
            const isSetup = await isPowerShellStartupSetup('powershell', profile);
            return isSetup ? ShellSetupState.Setup : ShellSetupState.NotSetup;
        } catch (err) {
            traceError('Failed to check if PowerShell startup is setup', err);
        }
        return ShellSetupState.NotSetup;
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isPowerShellInstalled('powershell');
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const profile = await getProfileForShell('powershell');
            const success = await setupPowerShellStartup('powershell', profile);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup PowerShell startup', err);
        }
        return ShellScriptEditState.NotEdited;
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isPowerShellInstalled('powershell');
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const profile = await getProfileForShell('powershell');
            const success = await removePowerShellStartup('powershell', profile);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to remove PowerShell startup', err);
        }
        return ShellScriptEditState.NotEdited;
    }
}

export class PwshStartupProvider implements ShellStartupScriptProvider {
    public readonly name: string = 'PowerShell';
    public readonly shellType: string = ShellConstants.PWSH;

    async isSetup(): Promise<ShellSetupState> {
        const isInstalled = await isPowerShellInstalled('pwsh');
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellSetupState.NotInstalled;
        }

        try {
            const profile = await getProfileForShell('pwsh');
            const isSetup = await isPowerShellStartupSetup('pwsh', profile);
            return isSetup ? ShellSetupState.Setup : ShellSetupState.NotSetup;
        } catch (err) {
            traceError('Failed to check if PowerShell startup is setup', err);
        }
        return ShellSetupState.NotSetup;
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isPowerShellInstalled('pwsh');
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const profile = await getProfileForShell('pwsh');
            const success = await setupPowerShellStartup('pwsh', profile);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup PowerShell startup', err);
        }
        return ShellScriptEditState.NotEdited;
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isPowerShellInstalled('pwsh');
        if (!isInstalled) {
            traceVerbose('PowerShell is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const profile = await getProfileForShell('pwsh');
            const success = await removePowerShellStartup('pwsh', profile);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to remove PowerShell startup', err);
        }
        return ShellScriptEditState.NotEdited;
    }
}
