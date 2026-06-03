import * as fs from 'fs-extra';
import path from 'path';
import { commands, ConfigurationTarget, l10n, window, workspace } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { traceLog, traceVerbose } from '../../common/logging';
import { PEP440Version } from '../../common/utils/pep440Version';
import { isWindows } from '../../common/utils/platformUtils';
import { ShellConstants } from '../../features/common/shellConstants';
import { getDefaultEnvManagerSetting, setDefaultEnvManagerBroken } from '../../features/settings/settingHelpers';
import { PythonProjectManager } from '../../internal.api';
import { Installable } from './types';

export function noop() {
    // do nothing
}

/**
 * In **contrast** to just checking `typeof` this will return `false` for `NaN`.
 * @returns whether the provided parameter is a JavaScript Number or not.
 */
export function isNumber(obj: unknown): obj is number {
    return typeof obj === 'number' && !isNaN(obj);
}

export function sortEnvironments(collection: PythonEnvironment[]): PythonEnvironment[] {
    return collection.sort((a, b) => {
        // Environments with errors should be sorted to the end
        if (a.error && !b.error) {
            return 1;
        }
        if (!a.error && b.error) {
            return -1;
        }
        if (a.version !== b.version) {
            const av = PEP440Version.parse(a.version);
            const bv = PEP440Version.parse(b.version);
            if (av && bv) {
                return PEP440Version.compare(bv, av); // descending
            }
            return a.version ? 1 : -1;
        }
        const value = a.name.localeCompare(b.name);
        if (value !== 0) {
            return value;
        }
        return a.environmentPath.fsPath.localeCompare(b.environmentPath.fsPath);
    });
}

export function getLatest(collection: PythonEnvironment[]): PythonEnvironment | undefined {
    if (collection.length === 0) {
        return undefined;
    }
    // Filter out environments with errors first, then find latest
    const nonErroredEnvs = collection.filter((e) => !e.error);
    const candidates = nonErroredEnvs.length > 0 ? nonErroredEnvs : collection;

    let latest = candidates[0];
    for (const env of candidates) {
        const av = PEP440Version.parse(env.version);
        const bv = PEP440Version.parse(latest.version);
        if (av && bv && PEP440Version.compare(av, bv) > 0) {
            latest = env;
        }
    }
    return latest;
}

export function mergePackages(common: Installable[], installed: string[]): Installable[] {
    const notInCommon = installed.filter((pkg) => !common.some((c) => c.name === pkg));
    return common
        .concat(notInCommon.map((pkg) => ({ name: pkg, displayName: pkg })))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function pathForGitBash(binPath: string): string {
    return isWindows() ? binPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '/$1') : binPath;
}

function buildPwshActivationCommands(ps1Path: string): PythonCommandRunConfiguration[] {
    const commands: PythonCommandRunConfiguration[] = [];
    if (isWindows()) {
        commands.push({
            executable: 'Set-ExecutionPolicy',
            args: ['-Scope', 'Process', '-ExecutionPolicy', 'RemoteSigned'],
        });
    }
    commands.push({ executable: '&', args: [ps1Path] });
    return commands;
}

export async function getShellActivationCommands(binDir: string): Promise<{
    shellActivation: Map<string, PythonCommandRunConfiguration[]>;
    shellDeactivation: Map<string, PythonCommandRunConfiguration[]>;
}> {
    const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();

    if (isWindows()) {
        shellActivation.set('unknown', [{ executable: path.join(binDir, `activate`) }]);
        shellDeactivation.set('unknown', [{ executable: path.join(binDir, `deactivate`) }]);
    } else {
        shellActivation.set('unknown', [{ executable: 'source', args: [path.join(binDir, `activate`)] }]);
        shellDeactivation.set('unknown', [{ executable: 'deactivate' }]);
    }

    shellActivation.set(ShellConstants.SH, [{ executable: 'source', args: [path.join(binDir, `activate`)] }]);
    shellDeactivation.set(ShellConstants.SH, [{ executable: 'deactivate' }]);

    shellActivation.set(ShellConstants.BASH, [{ executable: 'source', args: [path.join(binDir, `activate`)] }]);
    shellDeactivation.set(ShellConstants.BASH, [{ executable: 'deactivate' }]);

    shellActivation.set(ShellConstants.GITBASH, [
        { executable: 'source', args: [pathForGitBash(path.join(binDir, `activate`))] },
    ]);
    shellDeactivation.set(ShellConstants.GITBASH, [{ executable: 'deactivate' }]);

    shellActivation.set(ShellConstants.ZSH, [{ executable: 'source', args: [path.join(binDir, `activate`)] }]);
    shellDeactivation.set(ShellConstants.ZSH, [{ executable: 'deactivate' }]);

    shellActivation.set(ShellConstants.KSH, [{ executable: '.', args: [path.join(binDir, `activate`)] }]);
    shellDeactivation.set(ShellConstants.KSH, [{ executable: 'deactivate' }]);

    if (await fs.pathExists(path.join(binDir, 'Activate.ps1'))) {
        shellActivation.set(ShellConstants.PWSH, buildPwshActivationCommands(path.join(binDir, 'Activate.ps1')));
        shellDeactivation.set(ShellConstants.PWSH, [{ executable: 'deactivate' }]);
    } else if (await fs.pathExists(path.join(binDir, 'activate.ps1'))) {
        shellActivation.set(ShellConstants.PWSH, buildPwshActivationCommands(path.join(binDir, 'activate.ps1')));
        shellDeactivation.set(ShellConstants.PWSH, [{ executable: 'deactivate' }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.bat'))) {
        shellActivation.set(ShellConstants.CMD, [{ executable: path.join(binDir, `activate.bat`) }]);
        shellDeactivation.set(ShellConstants.CMD, [{ executable: path.join(binDir, `deactivate.bat`) }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.csh'))) {
        shellActivation.set(ShellConstants.CSH, [{ executable: 'source', args: [path.join(binDir, `activate.csh`)] }]);
        shellDeactivation.set(ShellConstants.CSH, [{ executable: 'deactivate' }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.fish'))) {
        shellActivation.set(ShellConstants.FISH, [
            { executable: 'source', args: [path.join(binDir, `activate.fish`)] },
        ]);
        shellDeactivation.set(ShellConstants.FISH, [{ executable: 'deactivate' }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.xsh'))) {
        shellActivation.set(ShellConstants.XONSH, [
            { executable: 'source', args: [path.join(binDir, `activate.xsh`)] },
        ]);
        shellDeactivation.set(ShellConstants.XONSH, [{ executable: 'deactivate' }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.nu'))) {
        shellActivation.set(ShellConstants.NU, [
            { executable: 'overlay', args: ['use', path.join(binDir, 'activate.nu')] },
        ]);
        shellDeactivation.set(ShellConstants.NU, [{ executable: 'overlay', args: ['hide', 'activate'] }]);
    }
    return {
        shellActivation,
        shellDeactivation,
    };
}

// Tracks if the broken defaultEnvManager error message has been shown this session
let hasShownBrokenDefaultEnvManagerError = false;

/**
 * Checks if the given managerId is set as the default environment manager for the project.
 * If so, marks the default manager as broken, refreshes environments, and shows an error message to the user.
 * The error message offers to reset the setting, view the setting, or close.
 * The error message is only shown once per session.
 *
 * @param managerId The environment manager id to check.
 * @param projectManager The Python project manager instance.
 * @param api The Python environment API instance.
 */
export async function notifyMissingManagerIfDefault(
    managerId: string,
    projectManager: PythonProjectManager,
    api: PythonEnvironmentApi,
) {
    const defaultEnvManager = getDefaultEnvManagerSetting(projectManager);
    if (defaultEnvManager === managerId) {
        if (hasShownBrokenDefaultEnvManagerError) {
            return;
        }
        hasShownBrokenDefaultEnvManagerError = true;
        setDefaultEnvManagerBroken(true);
        await api.refreshEnvironments(undefined);
        window
            .showErrorMessage(
                l10n.t(
                    "The default environment manager is set to '{0}', but the {1} executable could not be found.",
                    defaultEnvManager,
                    managerId.split(':')[1],
                ),
                l10n.t('Reset setting'),
                l10n.t('View setting'),
                l10n.t('Close'),
            )
            .then(async (selection) => {
                if (selection === 'Reset setting') {
                    const result = await removeFirstDefaultEnvManagerSettingDetailed(managerId);
                    if (!result.found) {
                        window
                            .showErrorMessage(
                                l10n.t(
                                    "Could not find a setting for 'defaultEnvManager' set to '{0}' to reset.",
                                    managerId,
                                ),
                                l10n.t('Open settings'),
                                l10n.t('Close'),
                            )
                            .then((sel) => {
                                if (sel === 'Open settings') {
                                    commands.executeCommand(
                                        'workbench.action.openSettings',
                                        'python-envs.defaultEnvManager',
                                    );
                                }
                            });
                    }
                }
                if (selection === 'View setting') {
                    commands.executeCommand('workbench.action.openSettings', 'python-envs.defaultEnvManager');
                }
            });
    }
}

/**
 * Removes the first occurrence of 'defaultEnvManager' set to managerId, returns where it was removed, and logs the action.
 * @param managerId The manager id to match and remove.
 * @returns { found: boolean, scope?: string }
 */
export async function removeFirstDefaultEnvManagerSettingDetailed(
    managerId: string,
): Promise<{ found: boolean; scope?: string }> {
    const config = workspace.getConfiguration('python-envs');
    const inspect = config.inspect('defaultEnvManager');

    // Workspace folder settings (multi-root)
    if (inspect?.workspaceFolderValue !== undefined && inspect.workspaceFolderValue === managerId) {
        await config.update('defaultEnvManager', undefined, ConfigurationTarget.WorkspaceFolder);
        traceLog("[python-envs] Removed 'defaultEnvManager' from Workspace Folder settings.");
        return { found: true, scope: 'Workspace Folder' };
    }
    // Workspace settings
    if (inspect?.workspaceValue !== undefined && inspect.workspaceValue === managerId) {
        await config.update('defaultEnvManager', undefined, ConfigurationTarget.Workspace);
        traceLog("[python-envs] Removed 'defaultEnvManager' from Workspace settings.");
        return { found: true, scope: 'Workspace' };
    }
    // User/global settings
    if (inspect?.globalValue !== undefined && inspect.globalValue === managerId) {
        await config.update('defaultEnvManager', undefined, ConfigurationTarget.Global);
        traceLog("[python-envs] Removed 'defaultEnvManager' from User/Global settings.");
        return { found: true, scope: 'User/Global' };
    }
    // No matching setting found
    traceVerbose(`[python-envs] Could not find 'defaultEnvManager' set to '${managerId}' in any scope.`);
    return { found: false };
}
