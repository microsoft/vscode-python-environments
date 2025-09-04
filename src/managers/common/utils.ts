import * as fs from 'fs-extra';
import path from 'path';
import { commands, ConfigurationTarget, window, workspace } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { isWindows } from '../../common/utils/platformUtils';
import { ShellConstants } from '../../features/common/shellConstants';
import { getDefaultEnvManagerSetting, setDefaultEnvManagerBroken } from '../../features/settings/settingHelpers';
import { PythonProjectManager } from '../../internal.api';
import { Installable } from './types';

export function noop() {
    // do nothing
}

export function shortVersion(version: string): string {
    const pattern = /(\d)\.(\d+)(?:\.(\d+)?)?/gm;
    const match = pattern.exec(version);
    if (match) {
        if (match[3]) {
            return `${match[1]}.${match[2]}.${match[3]}`;
        }
        return `${match[1]}.${match[2]}.x`;
    }
    return version;
}

export function isGreater(a: string | undefined, b: string | undefined): boolean {
    if (!a && !b) {
        return false;
    }
    if (!a) {
        return false;
    }
    if (!b) {
        return true;
    }

    try {
        const aParts = a.split('.');
        const bParts = b.split('.');
        for (let i = 0; i < aParts.length; i++) {
            if (i >= bParts.length) {
                return true;
            }
            const aPart = parseInt(aParts[i], 10);
            const bPart = parseInt(bParts[i], 10);
            if (aPart > bPart) {
                return true;
            }
            if (aPart < bPart) {
                return false;
            }
        }
    } catch {
        return false;
    }
    return false;
}

export function sortEnvironments(collection: PythonEnvironment[]): PythonEnvironment[] {
    return collection.sort((a, b) => {
        if (a.version !== b.version) {
            return isGreater(a.version, b.version) ? -1 : 1;
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
    let latest = collection[0];
    for (const env of collection) {
        if (isGreater(env.version, latest.version)) {
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

/**
 * Compares two semantic version strings. Support sonly simple 1.1.1 style versions.
 * @param version1 First version
 * @param version2 Second version
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split('.').map(Number);
    const v2Parts = version2.split('.').map(Number);

    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
        const v1Part = v1Parts[i] || 0;
        const v2Part = v2Parts[i] || 0;

        if (v1Part > v2Part) {
            return 1;
        }
        if (v1Part < v2Part) {
            return -1;
        }
    }

    return 0;
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
        shellActivation.set(ShellConstants.PWSH, [{ executable: '&', args: [path.join(binDir, `Activate.ps1`)] }]);
        shellDeactivation.set(ShellConstants.PWSH, [{ executable: 'deactivate' }]);
    } else if (await fs.pathExists(path.join(binDir, 'activate.ps1'))) {
        shellActivation.set(ShellConstants.PWSH, [{ executable: '&', args: [path.join(binDir, `activate.ps1`)] }]);
        shellDeactivation.set(ShellConstants.PWSH, [{ executable: 'deactivate' }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.bat'))) {
        shellActivation.set(ShellConstants.CMD, [{ executable: path.join(binDir, `activate.bat`) }]);
        shellDeactivation.set(ShellConstants.CMD, [{ executable: path.join(binDir, `deactivate.bat`) }]);
    }

    if (await fs.pathExists(path.join(binDir, 'activate.csh'))) {
        shellActivation.set(ShellConstants.CSH, [{ executable: 'source', args: [path.join(binDir, `activate.csh`)] }]);
        shellDeactivation.set(ShellConstants.CSH, [{ executable: 'deactivate' }]);

        shellActivation.set(ShellConstants.FISH, [{ executable: 'source', args: [path.join(binDir, `activate.csh`)] }]);
        shellDeactivation.set(ShellConstants.FISH, [{ executable: 'deactivate' }]);
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

export async function notifyMissingManagerIfDefault(
    managerId: string,
    projectManager: PythonProjectManager,
    api: PythonEnvironmentApi,
) {
    const defaultEnvManager = getDefaultEnvManagerSetting(projectManager);
    if (defaultEnvManager === managerId) {
        setDefaultEnvManagerBroken(true);
        await api.refreshEnvironments(undefined);
        window
            .showErrorMessage(
                `The default environment manager is set to '${defaultEnvManager}', but the ${
                    managerId.split(':')[1]
                } executable could not be found.`,
                'Reset setting',
                'View setting',
                'Close',
            )
            .then((selection) => {
                if (selection === 'Reset setting') {
                    // Remove the setting from all scopes
                    const config = workspace.getConfiguration('python-envs');
                    const inspect = config.inspect('defaultEnvManager');
                    if (inspect?.workspaceValue !== undefined) {
                        // Remove from workspace settings
                        config.update('defaultEnvManager', undefined, ConfigurationTarget.Workspace);
                    } else if (inspect?.globalValue !== undefined) {
                        // Remove from user settings
                        config.update('defaultEnvManager', undefined, ConfigurationTarget.Global);
                    }
                }
                if (selection === 'View setting') {
                    commands.executeCommand('workbench.action.openSettings', 'python-envs.defaultEnvManager');
                }
            });
    }
}
