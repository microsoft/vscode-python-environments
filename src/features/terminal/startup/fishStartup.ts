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

async function isFishInstalled(): Promise<boolean> {
    try {
        await which('fish');
        return true;
    } catch {
        return false;
    }
}

async function getFishProfile(): Promise<string> {
    const homeDir = os.homedir();
    // Fish configuration is typically at ~/.config/fish/config.fish
    const profilePath = path.join(homeDir, '.config', 'fish', 'config.fish');
    traceInfo(`SHELL: fish profile found at: ${profilePath}`);
    return profilePath;
}

const regionStart = '# >>> vscode python';
const regionEnd = '# <<< vscode python';

function getActivationContent(key: string): string {
    const lineSep = '\n';
    // In fish, environment variables are checked with set -q and evaluated with eval
    return ['', '', regionStart, `if set -q ${key}`, `    eval $${key}`, 'end', regionEnd, ''].join(lineSep);
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
            traceInfo(`SHELL: Created new fish profile at: ${profilePath}\n${activationContent}`);
        } else {
            // Update existing profile
            const content = await fs.readFile(profilePath, 'utf8');
            if (!content.includes(key)) {
                await fs.writeFile(profilePath, `${content}${activationContent}`);
                traceInfo(`SHELL: Updated existing fish profile at: ${profilePath}\n${activationContent}`);
            } else {
                // Already contains our activation code
                traceInfo(`SHELL: Fish profile at ${profilePath} already contains activation code`);
            }
        }
        return true;
    } catch (err) {
        traceVerbose(`Failed to setup fish startup`, err);
        return false;
    }
}

async function removeFishStartup(profilePath: string, key: string): Promise<boolean> {
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
            traceInfo(`Removed activation from fish profile at: ${profilePath}`);
        }
        return true;
    } catch (err) {
        traceVerbose(`Failed to remove fish startup`, err);
        return false;
    }
}

function getCommandAsString(command: PythonCommandRunConfiguration[]): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        // For fish, we need to ensure proper quoting
        parts.push(quoteArgs([cmd.executable, ...args]).join(' '));
    }
    return parts.join('; and '); // Fish uses 'and' instead of '&&'
}

export class FishStartupProvider implements ShellStartupProvider {
    public readonly name: string = 'Fish';
    public readonly fishActivationEnvVarKey = 'VSCODE_FISH_ACTIVATE';

    async isSetup(): Promise<ShellSetupState> {
        const isInstalled = await isFishInstalled();
        if (!isInstalled) {
            traceVerbose('Fish is not installed');
            return ShellSetupState.NotInstalled;
        }

        try {
            const fishProfile = await getFishProfile();
            const isSetup = await isStartupSetup(fishProfile, this.fishActivationEnvVarKey);
            return isSetup ? ShellSetupState.Setup : ShellSetupState.NotSetup;
        } catch (err) {
            traceError('Failed to check if Fish startup is setup', err);
            return ShellSetupState.NotSetup;
        }
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isFishInstalled();
        if (!isInstalled) {
            traceVerbose('Fish is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const fishProfile = await getFishProfile();
            const success = await setupStartup(fishProfile, this.fishActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup Fish startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isFishInstalled();
        if (!isInstalled) {
            traceVerbose('Fish is not installed');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const fishProfile = await getFishProfile();
            const success = await removeFishStartup(fishProfile, this.fishActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to remove Fish startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const fishActivation = getActivationCommandForShell(env, ShellConstants.FISH);
            if (fishActivation) {
                const command = getCommandAsString(fishActivation);
                collection.replace(this.fishActivationEnvVarKey, command);
            } else {
                collection.delete(this.fishActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update Fish environment variables', err);
            collection.delete(this.fishActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(this.fishActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.fishActivationEnvVarKey, undefined]]);
        }

        try {
            const fishActivation = getActivationCommandForShell(env, ShellConstants.FISH);
            return fishActivation
                ? new Map([[this.fishActivationEnvVarKey, getCommandAsString(fishActivation)]])
                : undefined;
        } catch (err) {
            traceError('Failed to get Fish environment variables', err);
            return undefined;
        }
    }
}
