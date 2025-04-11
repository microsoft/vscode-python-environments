import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { isWindows } from '../../../common/utils/platformUtils';
import { ShellScriptEditState, ShellSetupState, ShellStartupScriptProvider } from './startupProvider';
import { EnvironmentVariableCollection } from 'vscode';
import { PythonEnvironment } from '../../../api';
import { getShellActivationCommand } from '../../common/activation';
import { traceError, traceInfo, traceVerbose } from '../../../common/logging';
import { getCommandAsString } from './utils';
import which from 'which';
import * as cp from 'child_process';
import { promisify } from 'util';
import { ShellConstants } from '../../common/shellConstants';

const exec = promisify(cp.exec);

async function isCmdInstalled(): Promise<boolean> {
    if (!isWindows()) {
        return false;
    }

    if (process.env.ComSpec && (await fs.exists(process.env.ComSpec))) {
        return true;
    }

    try {
        // Try to find cmd.exe on the system
        await which('cmd.exe', { nothrow: true });
        return true;
    } catch {
        // This should normally not happen on Windows
        return false;
    }
}

interface CmdFilePaths {
    startupFile: string;
    regStartupFile: string;
    mainBatchFile: string;
    regMainBatchFile: string;
}

async function getCmdFilePaths(): Promise<CmdFilePaths> {
    const homeDir = process.env.USERPROFILE ?? os.homedir();
    const cmdrcDir = path.join(homeDir, '.cmdrc');

    // Ensure the directory exists
    await fs.ensureDir(cmdrcDir);

    return {
        mainBatchFile: path.join(cmdrcDir, 'cmd_startup.bat'),
        regMainBatchFile: path.join('%USERPROFILE%', '.cmdrc', 'cmd_startup.bat'),
        startupFile: path.join(cmdrcDir, 'vscode-python-cmd-init.cmd'),
        regStartupFile: path.join('%USERPROFILE%', '.cmdrc', 'vscode-python-cmd-init.cmd'),
    };
}

const regionStart = 'rem >>> vscode python';
const regionEnd = 'rem <<< vscode python';

function getActivationContent(key: string): string {
    const lineSep = isWindows() ? '\r\n' : '\n';
    return ['', '', regionStart, `if defined ${key} (`, `    call %${key}%`, ')', regionEnd, ''].join(lineSep);
}

function getMainBatchFileContent(startupFile: string, existingContent?: string): string {
    const lineSep = isWindows() ? '\r\n' : '\n';
    let content = [];

    // Add header
    content.push('@echo off');
    content.push('rem startup used in HKCU\\Software\\Microsoft\\Command Processor key AutoRun');
    content.push('');

    // Add existing AutoRun content if any
    if (existingContent && existingContent.trim()) {
        content.push(existingContent);
        content.push('');
    }

    // Add our startup file call
    content.push('rem VS Code Python environment activation');
    content.push('if not defined VSCODE_PYTHON_AUTOACTIVATE_GUARD (');
    content.push('    set "VSCODE_PYTHON_AUTOACTIVATE_GUARD=1"');
    content.push(`    if exist "${startupFile}" call "${startupFile}"`);
    content.push(')');
    content.push('');

    return content.join(lineSep);
}

async function checkRegistryAutoRun(mainBatchFile: string, regMainBatchFile: string): Promise<boolean> {
    if (!isWindows()) {
        return false;
    }

    try {
        // Check if AutoRun is set in the registry to call our batch file
        const { stdout } = await exec('reg query "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun', {
            windowsHide: true,
        });

        // Check if the output contains our batch file path
        return stdout.includes(regMainBatchFile) || stdout.includes(mainBatchFile);
    } catch {
        // If the command fails, the registry key might not exist
        return false;
    }
}

async function getExistingAutoRun(): Promise<string | undefined> {
    if (!isWindows()) {
        return undefined;
    }

    try {
        const { stdout } = await exec('reg query "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun', {
            windowsHide: true,
        });

        const match = stdout.match(/AutoRun\s+REG_SZ\s+(.*)/);
        if (match && match[1]) {
            const content = match[1].trim();
            return content;
        }
    } catch {
        // Key doesn't exist yet
    }

    return undefined;
}

async function setupRegistryAutoRun(mainBatchFile: string): Promise<boolean> {
    if (!isWindows()) {
        return false;
    }

    try {
        // Set the registry key to call our main batch file
        await exec(
            `reg add "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun /t REG_SZ /d "call \\"${mainBatchFile}\\"" /f`,
            { windowsHide: true },
        );

        traceInfo(
            `Set CMD AutoRun registry key [HKCU\\Software\\Microsoft\\Command Processor] to call: ${mainBatchFile}`,
        );
        return true;
    } catch (err) {
        traceError('Failed to set CMD AutoRun registry key [HKCU\\Software\\Microsoft\\Command Processor]', err);
        return false;
    }
}

async function isCmdStartupSetup(cmdFiles: CmdFilePaths, key: string): Promise<ShellSetupState> {
    // Check both the startup file and registry AutoRun setting
    const fileExists = await fs.pathExists(cmdFiles.startupFile);
    const fileHasContent = fileExists ? (await fs.readFile(cmdFiles.startupFile, 'utf8')).includes(key) : false;
    if (!fileHasContent) {
        return ShellSetupState.NotSetup;
    }

    const mainFileExists = await fs.pathExists(cmdFiles.mainBatchFile);
    let mainFileHasContent = false;
    if (mainFileExists) {
        const mainFileContent = await fs.readFile(cmdFiles.mainBatchFile, 'utf8');
        mainFileHasContent =
            mainFileContent.includes(cmdFiles.regStartupFile) || mainFileContent.includes(cmdFiles.startupFile);
    }

    if (!mainFileHasContent) {
        return ShellSetupState.NotSetup;
    }

    const registrySetup = await checkRegistryAutoRun(cmdFiles.regMainBatchFile, cmdFiles.mainBatchFile);
    return registrySetup ? ShellSetupState.Setup : ShellSetupState.NotSetup;
}

async function setupCmdStartup(cmdFiles: CmdFilePaths, key: string): Promise<boolean> {
    try {
        const activationContent = getActivationContent(key);

        // Step 1: Create or update the activation file
        if (!(await fs.pathExists(cmdFiles.startupFile))) {
            await fs.writeFile(cmdFiles.startupFile, activationContent);
            traceInfo(`SHELL: Created new CMD activation file at: ${cmdFiles.startupFile}\r\n${activationContent}`);
        } else {
            const content = await fs.readFile(cmdFiles.startupFile, 'utf8');
            if (!content.includes(key)) {
                await fs.writeFile(cmdFiles.startupFile, `${content}${activationContent}`);
                traceInfo(
                    `SHELL: Updated existing CMD activation file at: ${cmdFiles.startupFile}\r\n${activationContent}`,
                );
            } else {
                traceInfo(`SHELL: CMD activation file at ${cmdFiles.startupFile} already contains activation code`);
            }
        }

        // Step 2: Get existing AutoRun content
        const existingAutoRun = await getExistingAutoRun();

        // Step 3: Create or update the main batch file
        const mainBatchContent = getMainBatchFileContent(cmdFiles.regStartupFile, existingAutoRun);
        if (mainBatchContent.includes(cmdFiles.regMainBatchFile) || mainBatchContent.includes(cmdFiles.mainBatchFile)) {
            traceInfo(`SHELL: CMD main batch file already contains our startup file`);
        } else {
            await fs.writeFile(cmdFiles.mainBatchFile, mainBatchContent);
            traceInfo(`SHELL: Created/Updated main batch file at: ${cmdFiles.mainBatchFile}`);
        }

        // Step 4: Setup registry AutoRun to call our main batch file
        if (existingAutoRun?.includes(cmdFiles.regMainBatchFile) || existingAutoRun?.includes(cmdFiles.mainBatchFile)) {
            traceInfo(`SHELL: CMD AutoRun registry key already contains our main batch file`);
        } else {
            const registrySetup = await setupRegistryAutoRun(cmdFiles.mainBatchFile);
            return registrySetup;
        }
        return true;
    } catch (err) {
        traceVerbose(`Failed to setup CMD startup`, err);
        return false;
    }
}

async function removeCmdStartup(startupFile: string): Promise<boolean> {
    let success = true;

    // Remove from activation file if it exists
    if (await fs.pathExists(startupFile)) {
        try {
            const content = await fs.readFile(startupFile, 'utf8');
            if (content.includes(regionStart)) {
                // Remove the entire region including newlines
                const pattern = new RegExp(`${regionStart}[\\s\\S]*?${regionEnd}\\r?\\n?`, 'g');
                const newContent = content.replace(pattern, '');

                if (newContent.trim() === '') {
                    // Delete the file if it's empty after removal
                    await fs.remove(startupFile);
                    traceInfo(`Removed CMD activation file: ${startupFile}`);
                } else {
                    await fs.writeFile(startupFile, newContent);
                    traceInfo(`Removed activation from CMD activation file at: ${startupFile}`);
                }
            }
        } catch (err) {
            traceVerbose(`Failed to remove CMD activation file content`, err);
            success = false;
        }
    }

    // Note: We deliberately DO NOT remove the main batch file or registry AutoRun setting
    // This allows other components to continue using the AutoRun functionality

    return success;
}

export class CmdStartupProvider implements ShellStartupScriptProvider {
    public readonly name: string = 'Command Prompt';
    private readonly cmdActivationEnvVarKey = 'VSCODE_CMD_ACTIVATE';

    async isSetup(): Promise<ShellSetupState> {
        const isInstalled = await isCmdInstalled();
        if (!isInstalled) {
            traceVerbose('CMD is not installed or not on Windows');
            return ShellSetupState.NotInstalled;
        }

        try {
            const cmdFiles = await getCmdFilePaths();
            const isSetup = await isCmdStartupSetup(cmdFiles, this.cmdActivationEnvVarKey);
            return isSetup;
        } catch (err) {
            traceError('Failed to check if CMD startup is setup', err);
            return ShellSetupState.NotSetup;
        }
    }

    async setupScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isCmdInstalled();
        if (!isInstalled) {
            traceVerbose('CMD is not installed or not on Windows');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const cmdFiles = await getCmdFilePaths();
            const success = await setupCmdStartup(cmdFiles, this.cmdActivationEnvVarKey);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to setup CMD startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async teardownScripts(): Promise<ShellScriptEditState> {
        const isInstalled = await isCmdInstalled();
        if (!isInstalled) {
            traceVerbose('CMD is not installed or not on Windows');
            return ShellScriptEditState.NotInstalled;
        }

        try {
            const { startupFile } = await getCmdFilePaths();
            const success = await removeCmdStartup(startupFile);
            return success ? ShellScriptEditState.Edited : ShellScriptEditState.NotEdited;
        } catch (err) {
            traceError('Failed to remove CMD startup', err);
            return ShellScriptEditState.NotEdited;
        }
    }

    async updateEnvVariables(collection: EnvironmentVariableCollection, env: PythonEnvironment): Promise<void> {
        try {
            const cmdActivation = getShellActivationCommand(env, ShellConstants.CMD);
            if (cmdActivation) {
                const command = getCommandAsString(cmdActivation, '&');
                collection.replace(this.cmdActivationEnvVarKey, command);
            } else {
                collection.delete(this.cmdActivationEnvVarKey);
            }
        } catch (err) {
            traceError('Failed to update CMD environment variables', err);
            collection.delete(this.cmdActivationEnvVarKey);
        }
    }

    async removeEnvVariables(envCollection: EnvironmentVariableCollection): Promise<void> {
        envCollection.delete(this.cmdActivationEnvVarKey);
    }

    async getEnvVariables(env?: PythonEnvironment): Promise<Map<string, string | undefined> | undefined> {
        if (!env) {
            return new Map([[this.cmdActivationEnvVarKey, undefined]]);
        }

        try {
            const cmdActivation = getShellActivationCommand(env, ShellConstants.CMD);
            return cmdActivation
                ? new Map([[this.cmdActivationEnvVarKey, getCommandAsString(cmdActivation, '&')]])
                : undefined;
        } catch (err) {
            traceError('Failed to get CMD environment variables', err);
            return undefined;
        }
    }
}
