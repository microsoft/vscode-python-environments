// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { traceError, traceInfo, traceVerbose } from '../../common/logging';
import { isWindows } from '../../common/utils/platformUtils';

/**
 * Shell-specific sourcing scripts for conda activation.
 * Each field is optional since not all scripts may be available on all systems.
 */
export interface ShellSourcingScripts {
    /** PowerShell hook script (conda-hook.ps1) */
    ps1?: string;
    /** Bash/sh initialization script (conda.sh) */
    sh?: string;
    /** Windows CMD batch file (activate.bat) */
    cmd?: string;
    /** Fish shell initialization script (conda.fish) */
    fish?: string;
}

/**
 * Tracks whether `conda init <shell>` has been run for each shell type.
 * When true, the shell's profile/config file contains the conda initialization block,
 * meaning bare `conda` will be available as a shell function when that shell starts.
 */
export interface ShellCondaInitStatus {
    bash?: boolean;
    zsh?: boolean;
    fish?: boolean;
    pwsh?: boolean;
}

/**
 * Represents the status of conda sourcing in the current environment
 */
export class CondaSourcingStatus {
    /**
     * Creates a new CondaSourcingStatus instance
     * @param condaPath Path to the conda installation
     * @param condaFolder Path to the conda installation folder (derived from condaPath)
     * @param isActiveOnLaunch Whether conda was activated before VS Code launch
     * @param globalSourcingScript Path to the global sourcing script (if exists)
     * @param shellSourcingScripts Shell-specific sourcing scripts (if found)
     */
    constructor(
        public readonly condaPath: string,
        public readonly condaFolder: string,
        public isActiveOnLaunch?: boolean,
        public globalSourcingScript?: string,
        public shellSourcingScripts?: ShellSourcingScripts,
        public shellInitStatus?: ShellCondaInitStatus,
    ) {}

    /**
     * Returns a formatted string representation of the conda sourcing status
     */
    toString(): string {
        const lines: string[] = [];
        lines.push('Conda Sourcing Status:');
        lines.push(`├─ Conda Path: ${this.condaPath}`);
        lines.push(`├─ Conda Folder: ${this.condaFolder}`);
        lines.push(`├─ Active on Launch: ${this.isActiveOnLaunch ?? 'false'}`);

        if (this.globalSourcingScript) {
            lines.push(`├─ Global Sourcing Script: ${this.globalSourcingScript}`);
        }

        if (this.shellSourcingScripts) {
            const scripts = this.shellSourcingScripts;
            const entries = [
                scripts.ps1 && `PowerShell: ${scripts.ps1}`,
                scripts.sh && `Bash/sh: ${scripts.sh}`,
                scripts.cmd && `CMD: ${scripts.cmd}`,
                scripts.fish && `Fish: ${scripts.fish}`,
            ].filter(Boolean);

            if (entries.length > 0) {
                lines.push('└─ Shell-specific Sourcing Scripts:');
                entries.forEach((entry, index, array) => {
                    const isLast = index === array.length - 1;
                    lines.push(`   ${isLast ? '└─' : '├─'} ${entry}`);
                });
            } else {
                lines.push('└─ No Shell-specific Sourcing Scripts Found');
            }
        } else {
            lines.push('└─ No Shell-specific Sourcing Scripts Found');
        }

        if (this.shellInitStatus) {
            const initEntries = (['bash', 'zsh', 'fish', 'pwsh'] as const)
                .map((s) => `${s}: ${this.shellInitStatus![s] ? '✓' : '✗'}`)
                .join(', ');
            lines.push(`├─ Shell conda init status: ${initEntries}`);
        }

        return lines.join('\n');
    }
}

/**
 * Constructs the conda sourcing status for a given conda installation
 * @param condaPath The path to the conda executable
 * @returns A CondaSourcingStatus object containing:
 *          - Whether conda was active when VS Code launched
 *          - Path to global sourcing script (if found)
 *          - Paths to shell-specific sourcing scripts (if found)
 *
 * This function checks:
 * 1. If conda is already active in the current shell (CONDA_SHLVL)
 * 2. Location of the global activation script
 * 3. Location of shell-specific activation scripts
 */
export async function constructCondaSourcingStatus(condaPath: string): Promise<CondaSourcingStatus> {
    const condaFolder = path.dirname(path.dirname(condaPath));
    let sourcingStatus = new CondaSourcingStatus(condaPath, condaFolder);

    // The `conda_shlvl` value indicates whether conda is properly initialized in the current shell:
    // - `-1`: Conda has never been sourced
    // - `undefined`: No shell level information available
    // - `0 or higher`: Conda is properly sourced in the shell
    const condaShlvl = process.env.CONDA_SHLVL;
    if (condaShlvl && parseInt(condaShlvl) >= 0) {
        sourcingStatus.isActiveOnLaunch = true;
        // if activation already occurred, no need to find further scripts
        return sourcingStatus;
    }

    // Attempt to find the GLOBAL conda sourcing script
    const globalSourcingScript: string | undefined = await findGlobalSourcingScript(sourcingStatus.condaFolder);
    if (globalSourcingScript) {
        sourcingStatus.globalSourcingScript = globalSourcingScript;
        // note: future iterations could decide to exit here instead of continuing to generate all the other activation scripts
    }

    // find and save all of the shell specific sourcing scripts
    sourcingStatus.shellSourcingScripts = await findShellSourcingScripts(sourcingStatus);

    // check shell profile files to see if `conda init <shell>` has been run
    sourcingStatus.shellInitStatus = await checkCondaInitInShellProfiles();

    return sourcingStatus;
}

/**
 * Finds the global conda activation script for the given conda installation
 * @param condaPath The path to the conda executable
 * @returns The path to the global activation script if it exists, undefined otherwise
 *
 * On Windows, this will look for 'Scripts/activate.bat'
 * On Unix systems, this will look for 'bin/activate'
 */
export async function findGlobalSourcingScript(condaFolder: string): Promise<string | undefined> {
    const sourcingScript = isWindows()
        ? path.join(condaFolder, 'Scripts', 'activate.bat')
        : path.join(condaFolder, 'bin', 'activate');

    if (await fse.pathExists(sourcingScript)) {
        traceInfo(`Found global conda sourcing script at: ${sourcingScript}`);
        return sourcingScript;
    } else {
        traceInfo(`No global conda sourcing script found.  at: ${sourcingScript}`);
        return undefined;
    }
}

export async function findShellSourcingScripts(sourcingStatus: CondaSourcingStatus): Promise<ShellSourcingScripts> {
    const logs: string[] = [];
    logs.push('=== Conda Sourcing Shell Script Search ===');

    let ps1Script: string | undefined;
    let shScript: string | undefined;
    let cmdActivate: string | undefined;
    let fishScript: string | undefined;

    try {
        // Search for PowerShell hook script (conda-hook.ps1)
        logs.push('Searching for PowerShell hook script...');
        try {
            ps1Script = await getCondaHookPs1Path(sourcingStatus.condaFolder);
            logs.push(`  Path: ${ps1Script ?? '✗ Not found'}`);
        } catch (err) {
            logs.push(
                `  Error during PowerShell script search: ${err instanceof Error ? err.message : 'Unknown error'}`,
            );
        }

        // Search for Shell script (conda.sh)
        logs.push('\nSearching for Shell script...');
        try {
            shScript = await getCondaShPath(sourcingStatus.condaFolder);
            logs.push(`  Path: ${shScript ?? '✗ Not found'}`);
        } catch (err) {
            logs.push(`  Error during Shell script search: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }

        // Search for Windows CMD script (activate.bat)
        logs.push('\nSearching for Windows CMD script...');
        try {
            cmdActivate = await getCondaBatActivationFile(sourcingStatus.condaPath);
            logs.push(`  Path: ${cmdActivate ?? '✗ Not found'}`);
        } catch (err) {
            logs.push(`  Error during CMD script search: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }

        // Search for Fish shell script (conda.fish)
        logs.push('\nSearching for Fish shell script...');
        try {
            fishScript = await getCondaFishPath(sourcingStatus.condaFolder);
            logs.push(`  Path: ${fishScript ?? '✗ Not found'}`);
        } catch (err) {
            logs.push(`  Error during Fish script search: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    } catch (error) {
        logs.push(`\nCritical error during script search: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
        logs.push('\nSearch Summary:');
        logs.push(`  PowerShell: ${ps1Script ? '✓' : '✗'}`);
        logs.push(`  Shell: ${shScript ? '✓' : '✗'}`);
        logs.push(`  CMD: ${cmdActivate ? '✓' : '✗'}`);
        logs.push(`  Fish: ${fishScript ? '✓' : '✗'}`);
        logs.push('============================');

        // Log everything at once
        traceVerbose(logs.join('\n'));
    }

    return { ps1: ps1Script, sh: shScript, cmd: cmdActivate, fish: fishScript };
}

/**
 * Checks shell profile/config files to determine if `conda init <shell>` has been run.
 *
 * When `conda init <shell>` is run, it adds a `# >>> conda initialize >>>` block to the
 * shell's profile. If that block is present, then any new terminal of that shell type will
 * have `conda` available as a shell function, and bare `conda activate` will work.
 *
 * For Fish, `conda init fish` may either modify `config.fish` or drop a file in
 * `~/.config/fish/conf.d/`, so both locations are checked.
 *
 * @param homeDir Optional home directory override (defaults to os.homedir(), useful for testing)
 * @returns Status object indicating which shells have conda initialized
 */
export async function checkCondaInitInShellProfiles(homeDir?: string): Promise<ShellCondaInitStatus> {
    const home = homeDir ?? os.homedir();
    const status: ShellCondaInitStatus = {};
    const logs: string[] = ['=== Checking shell profiles for conda init ==='];

    const checks: Array<{ shell: keyof ShellCondaInitStatus; files: string[] }> = [
        {
            shell: 'bash',
            files: [path.join(home, '.bashrc'), path.join(home, '.bash_profile')],
        },
        {
            shell: 'zsh',
            files: [path.join(home, '.zshrc')],
        },
        {
            shell: 'fish',
            files: [
                path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'config.fish'),
                path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'conda.fish'),
            ],
        },
        {
            shell: 'pwsh',
            files: [
                path.join(
                    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
                    'powershell',
                    'Microsoft.PowerShell_profile.ps1',
                ),
                path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'powershell', 'profile.ps1'),
            ],
        },
    ];

    await Promise.all(
        checks.map(async ({ shell, files }) => {
            for (const filePath of files) {
                try {
                    if (await fse.pathExists(filePath)) {
                        const content = await fse.readFile(filePath, 'utf-8');
                        if (content.includes('conda initialize')) {
                            status[shell] = true;
                            logs.push(`  ${shell}: ✓ conda init found in ${filePath}`);
                            return;
                        }
                    }
                } catch {
                    // File not readable, skip
                }
            }
            logs.push(`  ${shell}: ✗ conda init not found`);
        }),
    );

    logs.push('============================');
    traceVerbose(logs.join('\n'));

    return status;
}

/**
 * Returns the best guess path to conda-hook.ps1 given a conda executable path.
 *
 * Searches for conda-hook.ps1 in these locations (relative to the conda root):
 *   - shell/condabin/
 *   - Library/shell/condabin/
 *   - condabin/
 *   - etc/profile.d/
 */
export async function getCondaHookPs1Path(condaFolder: string): Promise<string | undefined> {
    // Create the promise for finding the hook path
    const hookPathPromise = (async () => {
        const condaRootCandidates: string[] = [
            path.join(condaFolder, 'shell', 'condabin'),
            path.join(condaFolder, 'Library', 'shell', 'condabin'),
            path.join(condaFolder, 'condabin'),
            path.join(condaFolder, 'etc', 'profile.d'),
        ];

        const checks = condaRootCandidates.map(async (hookSearchDir) => {
            const candidate = path.join(hookSearchDir, 'conda-hook.ps1');
            if (await fse.pathExists(candidate)) {
                traceInfo(`Conda hook found at: ${candidate}`);
                return candidate;
            }
            return undefined;
        });
        const results = await Promise.all(checks);
        const found = results.find(Boolean);
        if (found) {
            return found as string;
        }
        return undefined;
    })();

    return hookPathPromise;
}

/**
 * Helper function that checks for a file in a list of locations.
 * Returns the first location where the file exists, or undefined if not found.
 */
async function findFileInLocations(locations: string[], description: string): Promise<string | undefined> {
    for (const location of locations) {
        if (await fse.pathExists(location)) {
            traceInfo(`${description} found in ${location}`);
            return location;
        }
    }
    return undefined;
}

/**
 * Returns the path to conda.sh given a conda executable path.
 *
 * Searches for conda.sh in these locations (relative to the conda root):
 * - etc/profile.d/conda.sh
 * - shell/etc/profile.d/conda.sh
 * - Library/etc/profile.d/conda.sh
 * - lib/pythonX.Y/site-packages/conda/shell/etc/profile.d/conda.sh
 * - site-packages/conda/shell/etc/profile.d/conda.sh
 * Also checks some system-level locations
 */
async function getCondaShPath(condaFolder: string): Promise<string | undefined> {
    // Create the promise for finding the conda.sh path
    const shPathPromise = (async () => {
        // First try standard conda installation locations
        const standardLocations = [
            path.join(condaFolder, 'etc', 'profile.d', 'conda.sh'),
            path.join(condaFolder, 'shell', 'etc', 'profile.d', 'conda.sh'),
            path.join(condaFolder, 'Library', 'etc', 'profile.d', 'conda.sh'),
        ];

        // Check standard locations first
        const standardLocation = await findFileInLocations(standardLocations, 'conda.sh');
        if (standardLocation) {
            return standardLocation;
        }

        // If not found in standard locations, try pip install locations
        // First, find all python* directories in lib
        let pythonDirs: string[] = [];
        const libPath = path.join(condaFolder, 'lib');
        try {
            const dirs = await fse.readdir(libPath);
            pythonDirs = dirs.filter((dir) => dir.startsWith('python'));
        } catch (err) {
            traceVerbose(`No lib directory found at ${libPath}, ${err}`);
        }

        const pipInstallLocations = [
            ...pythonDirs.map((ver) =>
                path.join(condaFolder, 'lib', ver, 'site-packages', 'conda', 'shell', 'etc', 'profile.d', 'conda.sh'),
            ),
            path.join(condaFolder, 'site-packages', 'conda', 'shell', 'etc', 'profile.d', 'conda.sh'),
        ];

        // Check pip install locations
        const pipLocation = await findFileInLocations(pipInstallLocations, 'conda.sh');
        if (pipLocation) {
            traceError(
                'WARNING: conda.sh was found in a pip install location. ' +
                    'This is not a supported configuration and may be deprecated in the future. ' +
                    'Please install conda in a standard location. ' +
                    'See https://docs.conda.io/projects/conda/en/latest/user-guide/install/index.html for proper installation instructions.',
            );
            return pipLocation;
        }
        return undefined;
    })();

    return shPathPromise;
}

/**
 * Returns the path to conda.fish given a conda installation folder.
 *
 * Searches for conda.fish in these locations (relative to the conda root):
 * - etc/fish/conf.d/conda.fish
 * - shell/etc/fish/conf.d/conda.fish
 * - Library/etc/fish/conf.d/conda.fish
 */
export async function getCondaFishPath(condaFolder: string): Promise<string | undefined> {
    const locations = [
        path.join(condaFolder, 'etc', 'fish', 'conf.d', 'conda.fish'),
        path.join(condaFolder, 'shell', 'etc', 'fish', 'conf.d', 'conda.fish'),
        path.join(condaFolder, 'Library', 'etc', 'fish', 'conf.d', 'conda.fish'),
    ];

    return findFileInLocations(locations, 'conda.fish');
}

/**
 * Returns the path to the Windows batch activation file (activate.bat) for conda
 * @param condaPath The path to the conda executable
 * @returns The path to activate.bat if it exists in the same directory as conda.exe, undefined otherwise
 *
 * This file is used specifically for CMD.exe activation on Windows systems.
 * It should be located in the same directory as the conda executable.
 */
async function getCondaBatActivationFile(condaPath: string): Promise<string | undefined> {
    const cmdActivate = path.join(path.dirname(condaPath), 'activate.bat');
    if (await fse.pathExists(cmdActivate)) {
        return cmdActivate;
    }
    return undefined;
}

/**
 * Returns the path to the local conda activation script
 * @param condaPath The path to the conda executable
 * @returns Promise that resolves to:
 *          - The path to the local 'activate' script if it exists in the same directory as conda
 *          - undefined if the script is not found
 *
 * This function checks for a local 'activate' script in the same directory as the conda executable.
 * This script is used for direct conda activation without shell-specific configuration.
 */

const knownSourcingScriptCache: string[] = [];
export async function getLocalActivationScript(condaPath: string): Promise<string | undefined> {
    // Define all possible paths to check
    const paths = [
        // Direct path
        isWindows() ? path.join(condaPath, 'Scripts', 'activate') : path.join(condaPath, 'bin', 'activate'),
        // One level up
        isWindows()
            ? path.join(path.dirname(condaPath), 'Scripts', 'activate')
            : path.join(path.dirname(condaPath), 'bin', 'activate'),
        // Two levels up
        isWindows()
            ? path.join(path.dirname(path.dirname(condaPath)), 'Scripts', 'activate')
            : path.join(path.dirname(path.dirname(condaPath)), 'bin', 'activate'),
    ];

    // Check each path in sequence
    for (const sourcingScript of paths) {
        // Check if any of the paths are in the cache
        if (knownSourcingScriptCache.includes(sourcingScript)) {
            traceVerbose(`Found local activation script in cache at: ${sourcingScript}`);
            return sourcingScript;
        }
        try {
            const exists = await fse.pathExists(sourcingScript);
            if (exists) {
                traceInfo(`Found local activation script at: ${sourcingScript}, adding to cache.`);
                knownSourcingScriptCache.push(sourcingScript);
                return sourcingScript;
            }
        } catch (err) {
            traceError(`Error checking for local activation script at ${sourcingScript}: ${err}`);
            continue;
        }
    }

    traceVerbose('No local activation script found in any of the expected locations');
    return undefined;
}
