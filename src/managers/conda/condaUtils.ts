import * as ch from 'child_process';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    CancellationError,
    CancellationToken,
    l10n,
    LogOutputChannel,
    ProgressLocation,
    QuickInputButtons,
    QuickPickItem,
    ThemeIcon,
    Uri,
} from 'vscode';
import which from 'which';
import {
    EnvironmentManager,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonCommandRunConfiguration,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
    PythonProject,
} from '../../api';
import { ENVS_EXTENSION_ID, EXTENSION_ROOT_DIR } from '../../common/constants';
import { showErrorMessageWithLogs } from '../../common/errors/utils';
import { Common, CondaStrings, PackageManagement, Pickers } from '../../common/localize';
import { traceError, traceInfo } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { pickProject } from '../../common/pickers/projects';
import { createDeferred } from '../../common/utils/deferred';
import { untildify } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import {
    showErrorMessage,
    showInputBox,
    showQuickPick,
    showQuickPickWithButtons,
    withProgress,
} from '../../common/window.apis';
import { getConfiguration } from '../../common/workspace.apis';
import { ShellConstants } from '../../features/common/shellConstants';
import { quoteArgs } from '../../features/execution/execUtils';
import { createShellStartupProviders } from '../../features/terminal/shells/providers';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { selectFromCommonPackagesToInstall } from '../common/pickers';
import { Installable } from '../common/types';
import { pathForGitBash, shortVersion, sortEnvironments } from '../common/utils';

export const CONDA_PATH_KEY = `${ENVS_EXTENSION_ID}:conda:CONDA_PATH`;
export const CONDA_PREFIXES_KEY = `${ENVS_EXTENSION_ID}:conda:CONDA_PREFIXES`;
export const CONDA_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:conda:WORKSPACE_SELECTED`;
export const CONDA_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:conda:GLOBAL_SELECTED`;

/**
 * Information about conda sourcing scripts for different shells
 */
export interface CondaSourcingInfo {
    /** Whether conda is already initialized in the shell profile */
    isInitialized: boolean;
    /** Path to the conda sourcing script (e.g., conda.sh, conda-hook.ps1) */
    sourcingScript?: string;
}

/**
 * Cache of conda sourcing information per shell type
 */
export interface CondaSourcingCache {
    /** Mapping from shell type to sourcing information */
    shells: Map<string, CondaSourcingInfo>;
    /** Available conda sourcing script paths that were found */
    availableScripts: {
        /** Path to conda.sh if found */
        condaSh?: string;
        /** Path to conda-hook.ps1 if found */
        condaHookPs1?: string;
    };
}

let condaPath: string | undefined;
let condaSourcingCache: CondaSourcingCache | undefined;
export async function clearCondaCache(): Promise<void> {
    condaPath = undefined;
    condaSourcingCache = undefined;
}

async function setConda(conda: string): Promise<void> {
    condaPath = conda;
    const state = await getWorkspacePersistentState();
    await state.set(CONDA_PATH_KEY, conda);
}

export function getCondaPathSetting(): string | undefined {
    const config = getConfiguration('python');
    const value = config.get<string>('condaPath');
    return value && typeof value === 'string' ? untildify(value) : value;
}

export async function getCondaForWorkspace(fsPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(CONDA_WORKSPACE_KEY);
    if (data) {
        try {
            return data[fsPath];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setCondaForWorkspace(fsPath: string, condaEnvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(CONDA_WORKSPACE_KEY)) ?? {};
    if (condaEnvPath) {
        data[fsPath] = condaEnvPath;
    } else {
        delete data[fsPath];
    }
    await state.set(CONDA_WORKSPACE_KEY, data);
}

/**
 * Search for conda sourcing scripts and check shell profiles for conda initialization.
 * This function should be called during extension startup to cache the information.
 */
export async function searchCondaSourcingInfo(): Promise<void> {
    try {
        const conda = await getConda();
        if (!conda) {
            traceInfo('Conda not found, skipping sourcing search');
            return;
        }

        const cache: CondaSourcingCache = {
            shells: new Map(),
            availableScripts: {},
        };

        // Search for conda sourcing scripts
        await searchCondaSourcingScripts(conda, cache);

        // Check shell profiles for conda initialization
        await checkShellProfilesForCondaInit(cache);

        condaSourcingCache = cache;
        traceInfo('Conda sourcing cache initialized');
    } catch (error) {
        traceError('Failed to search conda sourcing info', error);
    }
}

/**
 * Search for conda sourcing scripts in common locations
 */
async function searchCondaSourcingScripts(conda: string, cache: CondaSourcingCache): Promise<void> {
    const condaRoot = path.dirname(path.dirname(conda));
    
    // Add conda path from settings if available
    const condaPathSetting = getCondaPathSetting();
    const searchRoots = [condaRoot];
    if (condaPathSetting && condaPathSetting !== conda) {
        const settingRoot = path.dirname(path.dirname(condaPathSetting));
        if (settingRoot !== condaRoot) {
            searchRoots.push(settingRoot);
        }
    }

    // Search for conda.sh in all the specified locations
    const condaShCandidates: string[] = [];
    for (const root of searchRoots) {
        condaShCandidates.push(
            path.join(root, 'etc', 'profile.d', 'conda.sh'),
            path.join(root, 'shell', 'etc', 'profile.d', 'conda.sh'),
            path.join(root, 'Library', 'etc', 'profile.d', 'conda.sh'),
        );

        // Search in lib/pythonX.Y/site-packages/conda/shell/etc/profile.d/conda.sh
        try {
            const libDir = path.join(root, 'lib');
            if (await fse.pathExists(libDir)) {
                const pythonDirs = await fse.readdir(libDir);
                for (const pythonDir of pythonDirs) {
                    if (pythonDir.startsWith('python')) {
                        condaShCandidates.push(
                            path.join(root, 'lib', pythonDir, 'site-packages', 'conda', 'shell', 'etc', 'profile.d', 'conda.sh')
                        );
                    }
                }
            }
        } catch {
            // Ignore errors reading lib directory
        }

        // Search in site-packages/conda/shell/etc/profile.d/conda.sh
        condaShCandidates.push(
            path.join(root, 'site-packages', 'conda', 'shell', 'etc', 'profile.d', 'conda.sh')
        );
    }

    // Check system-level locations
    condaShCandidates.push(
        '/etc/profile.d/conda.sh',
        '/usr/share/conda/etc/profile.d/conda.sh',
        '/opt/conda/etc/profile.d/conda.sh',
        '/opt/miniconda3/etc/profile.d/conda.sh'
    );

    // Find the first existing conda.sh
    for (const candidate of condaShCandidates) {
        try {
            if (await fse.pathExists(candidate)) {
                cache.availableScripts.condaSh = candidate;
                traceInfo(`Found conda.sh at: ${candidate}`);
                break;
            }
        } catch {
            // Ignore errors checking individual files
        }
    }

    // Search for conda-hook.ps1 using existing logic
    try {
        cache.availableScripts.condaHookPs1 = await getCondaHookPs1Path(conda);
    } catch (error) {
        traceInfo('conda-hook.ps1 not found', error);
    }
}

/**
 * Check shell profiles for conda initialization
 */
async function checkShellProfilesForCondaInit(cache: CondaSourcingCache): Promise<void> {
    const shellProviders = createShellStartupProviders();
    
    for (const provider of shellProviders) {
        try {
            // Get the profile path for this shell
            const profilePath = await getShellProfilePath(provider.shellType);
            if (!profilePath) {
                continue;
            }

            // Check if conda is already initialized in this profile
            const isInitialized = await checkCondaInitInProfile(profilePath);
            
            // Determine the appropriate sourcing script
            let sourcingScript: string | undefined;
            if (provider.shellType === ShellConstants.PWSH || provider.shellType === 'powershell') {
                sourcingScript = cache.availableScripts.condaHookPs1;
            } else {
                sourcingScript = cache.availableScripts.condaSh;
            }

            cache.shells.set(provider.shellType, {
                isInitialized,
                sourcingScript,
            });

            traceInfo(`Shell ${provider.shellType}: initialized=${isInitialized}, script=${sourcingScript}`);
        } catch (error) {
            traceError(`Failed to check conda init for shell ${provider.shellType}`, error);
        }
    }
}

/**
 * Get the profile path for a shell type
 */
async function getShellProfilePath(shellType: string): Promise<string | undefined> {
    const homeDir = os.homedir();
    
    switch (shellType) {
        case ShellConstants.BASH:
        case ShellConstants.GITBASH:
            return path.join(homeDir, '.bashrc');
        case ShellConstants.ZSH:
            return path.join(homeDir, '.zshrc');
        case ShellConstants.FISH:
            return path.join(homeDir, '.config', 'fish', 'config.fish');
        case ShellConstants.PWSH:
        case 'powershell':
            // PowerShell profile path is more complex, for now return undefined
            return undefined;
        default:
            return undefined;
    }
}

/**
 * Check if conda initialization is present in a shell profile
 */
async function checkCondaInitInProfile(profilePath: string): Promise<boolean> {
    try {
        if (!(await fse.pathExists(profilePath))) {
            return false;
        }

        const content = await fse.readFile(profilePath, 'utf8');
        return content.includes('# >>> conda initialize >>>');
    } catch (error) {
        traceError(`Failed to read profile ${profilePath}`, error);
        return false;
    }
}

/**
 * Get the cached conda sourcing information for a shell type
 */
export function getCondaSourcingInfo(shellType: string): CondaSourcingInfo | undefined {
    return condaSourcingCache?.shells.get(shellType);
}

/**
 * Build shell activation commands using cached conda sourcing information
 */
function buildShellActivationCommands(
    conda: string,
    environmentName: string,
    _isPrefix = false,
): {
    shellActivation: Map<string, PythonCommandRunConfiguration[]>;
    shellDeactivation: Map<string, PythonCommandRunConfiguration[]>;
} {
    const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();

    // Fallback to old behavior if conda includes path separator
    const hasPath = conda.includes('/') || conda.includes('\\');

    if (condaSourcingCache) {
        // Use cached information
        for (const [shellType, sourcingInfo] of condaSourcingCache.shells) {
            if (sourcingInfo.sourcingScript && hasPath) {
                if (shellType === ShellConstants.PWSH || shellType === 'powershell') {
                    shellActivation.set(shellType, [
                        { executable: '&', args: [sourcingInfo.sourcingScript] },
                        { executable: 'conda', args: ['activate', environmentName] },
                    ]);
                } else if (shellType === ShellConstants.GITBASH && isWindows()) {
                    shellActivation.set(shellType, [
                        { executable: '.', args: [pathForGitBash(sourcingInfo.sourcingScript)] },
                        { executable: 'conda', args: ['activate', environmentName] },
                    ]);
                } else {
                    shellActivation.set(shellType, [
                        { executable: '.', args: [sourcingInfo.sourcingScript] },
                        { executable: 'conda', args: ['activate', environmentName] },
                    ]);
                }
            } else {
                // Fallback to just using conda command
                shellActivation.set(shellType, [{ executable: 'conda', args: ['activate', environmentName] }]);
            }
            
            shellDeactivation.set(shellType, [{ executable: 'conda', args: ['deactivate'] }]);
        }
    } else {
        // Fallback to old behavior if cache is not available
        const fallbackShells = [ShellConstants.BASH, ShellConstants.SH, ShellConstants.ZSH, ShellConstants.PWSH];
        if (isWindows()) {
            fallbackShells.push(ShellConstants.GITBASH, ShellConstants.CMD);
        }

        for (const shellType of fallbackShells) {
            if (hasPath) {
                if (shellType === ShellConstants.PWSH) {
                    // Use the old getCondaHookPs1Path logic as fallback
                    shellActivation.set(shellType, [{ executable: 'conda', args: ['activate', environmentName] }]);
                } else if (shellType === ShellConstants.CMD && isWindows()) {
                    const cmdActivate = path.join(path.dirname(conda), 'activate.bat');
                    shellActivation.set(shellType, [{ executable: cmdActivate, args: [environmentName] }]);
                } else {
                    const shActivate = path.join(path.dirname(path.dirname(conda)), 'etc', 'profile.d', 'conda.sh');
                    if (shellType === ShellConstants.GITBASH && isWindows()) {
                        shellActivation.set(shellType, [
                            { executable: '.', args: [pathForGitBash(shActivate)] },
                            { executable: 'conda', args: ['activate', environmentName] },
                        ]);
                    } else {
                        shellActivation.set(shellType, [
                            { executable: '.', args: [shActivate] },
                            { executable: 'conda', args: ['activate', environmentName] },
                        ]);
                    }
                }
            } else {
                shellActivation.set(shellType, [{ executable: 'conda', args: ['activate', environmentName] }]);
            }
            
            shellDeactivation.set(shellType, [{ executable: 'conda', args: ['deactivate'] }]);
        }
    }

    return { shellActivation, shellDeactivation };
}

export async function setCondaForWorkspaces(fsPath: string[], condaEnvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(CONDA_WORKSPACE_KEY)) ?? {};
    fsPath.forEach((s) => {
        if (condaEnvPath) {
            data[s] = condaEnvPath;
        } else {
            delete data[s];
        }
    });
    await state.set(CONDA_WORKSPACE_KEY, data);
}

export async function getCondaForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return await state.get(CONDA_GLOBAL_KEY);
}

export async function setCondaForGlobal(condaEnvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(CONDA_GLOBAL_KEY, condaEnvPath);
}

async function findConda(): Promise<readonly string[] | undefined> {
    try {
        return await which('conda', { all: true });
    } catch {
        return undefined;
    }
}

async function getCondaExecutable(native?: NativePythonFinder): Promise<string> {
    if (condaPath) {
        traceInfo(`Using conda from cache: ${condaPath}`);
        return untildify(condaPath);
    }

    const state = await getWorkspacePersistentState();
    condaPath = await state.get<string>(CONDA_PATH_KEY);
    if (condaPath) {
        traceInfo(`Using conda from persistent state: ${condaPath}`);
        return untildify(condaPath);
    }

    const paths = await findConda();
    if (paths && paths.length > 0) {
        condaPath = paths[0];
        traceInfo(`Using conda from PATH: ${condaPath}`);
        await state.set(CONDA_PATH_KEY, condaPath);
        return condaPath;
    }

    if (native) {
        const data = await native.refresh(false);
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'conda');
        if (managers.length > 0) {
            condaPath = managers[0].executable;
            traceInfo(`Using conda from native finder: ${condaPath}`);
            await state.set(CONDA_PATH_KEY, condaPath);
            return condaPath;
        }
    }

    throw new Error('Conda not found');
}

export async function getConda(native?: NativePythonFinder): Promise<string> {
    const conda = getCondaPathSetting();
    if (conda) {
        traceInfo(`Using conda from settings: ${conda}`);
        return conda;
    }

    return await getCondaExecutable(native);
}

async function _runConda(
    conda: string,
    args: string[],
    log?: LogOutputChannel,
    token?: CancellationToken,
): Promise<string> {
    const deferred = createDeferred<string>();
    args = quoteArgs(args);
    const proc = ch.spawn(conda, args, { shell: true });

    token?.onCancellationRequested(() => {
        proc.kill();
        deferred.reject(new CancellationError());
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => {
        const d = data.toString('utf-8');
        stdout += d;
        log?.info(d.trim());
    });
    proc.stderr?.on('data', (data) => {
        const d = data.toString('utf-8');
        stderr += d;
        log?.error(d.trim());
    });
    proc.on('close', () => {
        deferred.resolve(stdout);
    });
    proc.on('exit', (code) => {
        if (code !== 0) {
            deferred.reject(new Error(`Failed to run "conda ${args.join(' ')}":\n ${stderr}`));
        }
    });

    return deferred.promise;
}

async function runConda(args: string[], log?: LogOutputChannel, token?: CancellationToken): Promise<string> {
    const conda = await getConda();
    return await _runConda(conda, args, log, token);
}

async function runCondaExecutable(args: string[], log?: LogOutputChannel, token?: CancellationToken): Promise<string> {
    const conda = await getCondaExecutable(undefined);
    return await _runConda(conda, args, log, token);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCondaInfo(): Promise<any> {
    const raw = await runConda(['info', '--envs', '--json']);
    return JSON.parse(raw);
}

let prefixes: string[] | undefined;
async function getPrefixes(): Promise<string[]> {
    if (prefixes) {
        return prefixes;
    }

    const state = await getWorkspacePersistentState();
    prefixes = await state.get<string[]>(CONDA_PREFIXES_KEY);
    if (prefixes) {
        return prefixes;
    }

    const data = await getCondaInfo();
    prefixes = data['envs_dirs'] as string[];
    await state.set(CONDA_PREFIXES_KEY, prefixes);
    return prefixes;
}

export async function getDefaultCondaPrefix(): Promise<string> {
    const prefixes = await getPrefixes();
    return prefixes.length > 0 ? prefixes[0] : path.join(os.homedir(), '.conda', 'envs');
}

async function getVersion(root: string): Promise<string> {
    const files = await fse.readdir(path.join(root, 'conda-meta'));
    for (let file of files) {
        if (file.startsWith('python-3') && file.endsWith('.json')) {
            const content = fse.readJsonSync(path.join(root, 'conda-meta', file));
            return content['version'] as string;
        }
    }

    throw new Error('Python version not found');
}

function isPrefixOf(roots: string[], e: string): boolean {
    const t = path.normalize(e);
    for (let r of roots.map((r) => path.normalize(r))) {
        if (t.startsWith(r)) {
            return true;
        }
    }
    return false;
}

async function getNamedCondaPythonInfo(
    name: string,
    prefix: string,
    executable: string,
    version: string,
    conda: string,
): Promise<PythonEnvironmentInfo> {
    const sv = shortVersion(version);
    const { shellActivation, shellDeactivation } = buildShellActivationCommands(conda, name);

    return {
        name: name,
        environmentPath: Uri.file(prefix),
        displayName: `${name} (${sv})`,
        shortDisplayName: `${name}:${sv}`,
        displayPath: prefix,
        description: undefined,
        tooltip: prefix,
        version: version,
        sysPrefix: prefix,
        execInfo: {
            run: { executable: path.join(executable) },
            activatedRun: {
                executable: 'conda',
                args: ['run', '--live-stream', '--name', name, 'python'],
            },
            activation: [{ executable: 'conda', args: ['activate', name] }],
            deactivation: [{ executable: 'conda', args: ['deactivate'] }],
            shellActivation,
            shellDeactivation,
        },
        group: name !== 'base' ? 'Named' : undefined,
    };
}

async function getPrefixesCondaPythonInfo(
    prefix: string,
    executable: string,
    version: string,
    conda: string,
): Promise<PythonEnvironmentInfo> {
    const sv = shortVersion(version);
    const { shellActivation, shellDeactivation } = buildShellActivationCommands(conda, prefix, true);

    const basename = path.basename(prefix);
    return {
        name: basename,
        environmentPath: Uri.file(prefix),
        displayName: `${basename} (${sv})`,
        shortDisplayName: `${basename}:${sv}`,
        displayPath: prefix,
        description: undefined,
        tooltip: prefix,
        version: version,
        sysPrefix: prefix,
        execInfo: {
            run: { executable: path.join(executable) },
            activatedRun: {
                executable: conda,
                args: ['run', '--live-stream', '--prefix', prefix, 'python'],
            },
            activation: [{ executable: conda, args: ['activate', prefix] }],
            deactivation: [{ executable: conda, args: ['deactivate'] }],
            shellActivation,
            shellDeactivation,
        },
        group: 'Prefix',
    };
}

function getCondaWithoutPython(name: string, prefix: string, conda: string): PythonEnvironmentInfo {
    return {
        name: name,
        environmentPath: Uri.file(prefix),
        displayName: `${name} (no-python)`,
        shortDisplayName: `${name} (no-python)`,
        displayPath: prefix,
        description: prefix,
        tooltip: l10n.t('Conda environment without Python'),
        version: 'no-python',
        sysPrefix: prefix,
        iconPath: new ThemeIcon('stop'),
        execInfo: {
            run: { executable: conda },
        },
        group: name.length > 0 ? 'Named' : 'Prefix',
    };
}

async function nativeToPythonEnv(
    e: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    log: LogOutputChannel,
    conda: string,
    condaPrefixes: string[],
): Promise<PythonEnvironment | undefined> {
    if (!(e.prefix && e.executable && e.version)) {
        let name = e.name;
        const environment = api.createPythonEnvironmentItem(
            getCondaWithoutPython(name ?? '', e.prefix ?? '', conda),
            manager,
        );
        log.info(`Found a No-Python conda environment: ${e.executable ?? e.prefix ?? 'conda-no-python'}`);
        return environment;
    }

    if (e.name === 'base') {
        const environment = api.createPythonEnvironmentItem(
            await getNamedCondaPythonInfo('base', e.prefix, e.executable, e.version, conda),
            manager,
        );
        log.info(`Found base environment: ${e.prefix}`);
        return environment;
    } else if (!isPrefixOf(condaPrefixes, e.prefix)) {
        const environment = api.createPythonEnvironmentItem(
            await getPrefixesCondaPythonInfo(e.prefix, e.executable, e.version, conda),
            manager,
        );
        log.info(`Found prefix environment: ${e.prefix}`);
        return environment;
    } else {
        const basename = path.basename(e.prefix);
        const name = e.name ?? basename;
        const environment = api.createPythonEnvironmentItem(
            await getNamedCondaPythonInfo(name, e.prefix, e.executable, e.version, conda),
            manager,
        );
        log.info(`Found named environment: ${e.prefix}`);
        return environment;
    }
}

export async function resolveCondaPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const e = await nativeFinder.resolve(fsPath);
        if (e.kind !== NativePythonEnvironmentKind.conda) {
            return undefined;
        }
        const conda = await getConda();
        const condaPrefixes = await getPrefixes();
        return nativeToPythonEnv(e, api, manager, log, conda, condaPrefixes);
    } catch {
        return undefined;
    }
}

export async function refreshCondaEnvs(
    hardRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    log.info('Refreshing conda environments');
    const data = await nativeFinder.refresh(hardRefresh);

    let conda: string | undefined = undefined;
    try {
        conda = await getConda();
    } catch {
        conda = undefined;
    }
    if (conda === undefined) {
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'conda');
        conda = managers[0].executable;
        await setConda(conda);
    }

    const condaPath = conda;

    if (condaPath) {
        const condaPrefixes = await getPrefixes();
        const envs = data
            .filter((e) => isNativeEnvInfo(e))
            .map((e) => e as NativeEnvInfo)
            .filter((e) => e.kind === NativePythonEnvironmentKind.conda);
        const collection: PythonEnvironment[] = [];

        envs.forEach(async (e) => {
            const environment = await nativeToPythonEnv(e, api, manager, log, condaPath, condaPrefixes);
            if (environment) {
                collection.push(environment);
            }
        });

        return sortEnvironments(collection);
    }

    log.error('Conda not found');
    return [];
}

function getName(api: PythonEnvironmentApi, uris?: Uri | Uri[]): string | undefined {
    if (!uris) {
        return undefined;
    }
    if (Array.isArray(uris) && uris.length !== 1) {
        return undefined;
    }
    return api.getPythonProject(Array.isArray(uris) ? uris[0] : uris)?.name;
}

async function getLocation(api: PythonEnvironmentApi, uris: Uri | Uri[]): Promise<string | undefined> {
    if (!uris || (Array.isArray(uris) && (uris.length === 0 || uris.length > 1))) {
        const projects: PythonProject[] = [];
        if (Array.isArray(uris)) {
            for (let uri of uris) {
                const project = api.getPythonProject(uri);
                if (project && !projects.includes(project)) {
                    projects.push(project);
                }
            }
        } else {
            api.getPythonProjects().forEach((p) => projects.push(p));
        }
        const project = await pickProject(projects);
        return project?.uri.fsPath;
    }
    return api.getPythonProject(Array.isArray(uris) ? uris[0] : uris)?.uri.fsPath;
}

export async function createCondaEnvironment(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    uris?: Uri | Uri[],
): Promise<PythonEnvironment | undefined> {
    // step1 ask user for named or prefix environment
    const envType =
        Array.isArray(uris) && uris.length > 1
            ? 'Named'
            : (
                  await showQuickPick(
                      [
                          { label: CondaStrings.condaNamed, description: CondaStrings.condaNamedDescription },
                          { label: CondaStrings.condaPrefix, description: CondaStrings.condaPrefixDescription },
                      ],
                      {
                          placeHolder: CondaStrings.condaSelectEnvType,
                          ignoreFocusOut: true,
                      },
                  )
              )?.label;

    if (envType) {
        return envType === CondaStrings.condaNamed
            ? await createNamedCondaEnvironment(api, log, manager, getName(api, uris ?? []))
            : await createPrefixCondaEnvironment(api, log, manager, await getLocation(api, uris ?? []));
    }
    return undefined;
}

async function createNamedCondaEnvironment(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    name?: string,
): Promise<PythonEnvironment | undefined> {
    name = await showInputBox({
        prompt: CondaStrings.condaNamedInput,
        value: name,
        ignoreFocusOut: true,
    });
    if (!name) {
        return;
    }

    const envName: string = name;

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: l10n.t('Creating conda environment: {0}', envName),
        },
        async () => {
            try {
                const bin = os.platform() === 'win32' ? 'python.exe' : 'python';
                const output = await runCondaExecutable(['create', '--yes', '--name', envName, 'python']);
                log.info(output);

                const prefixes = await getPrefixes();
                let envPath = '';
                for (let prefix of prefixes) {
                    if (await fse.pathExists(path.join(prefix, envName))) {
                        envPath = path.join(prefix, envName);
                        break;
                    }
                }
                const version = await getVersion(envPath);

                const environment = api.createPythonEnvironmentItem(
                    await getNamedCondaPythonInfo(envName, envPath, path.join(envPath, bin), version, await getConda()),
                    manager,
                );
                return environment;
            } catch (e) {
                log.error('Failed to create conda environment', e);
                setImmediate(async () => {
                    await showErrorMessageWithLogs(CondaStrings.condaCreateFailed, log);
                });
            }
        },
    );
}

async function createPrefixCondaEnvironment(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    fsPath?: string,
): Promise<PythonEnvironment | undefined> {
    if (!fsPath) {
        return;
    }

    let name = `./.conda`;
    if (await fse.pathExists(path.join(fsPath, '.conda'))) {
        log.warn(`Environment "${path.join(fsPath, '.conda')}" already exists`);
        const newName = await showInputBox({
            prompt: l10n.t('Environment "{0}" already exists. Enter a different name', name),
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (value === name) {
                    return CondaStrings.condaExists;
                }
                return undefined;
            },
        });
        if (!newName) {
            return;
        }
        name = newName;
    }

    const prefix: string = path.isAbsolute(name) ? name : path.join(fsPath, name);

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: `Creating conda environment: ${name}`,
        },
        async () => {
            try {
                const bin = os.platform() === 'win32' ? 'python.exe' : 'python';
                const output = await runCondaExecutable(['create', '--yes', '--prefix', prefix, 'python']);
                log.info(output);
                const version = await getVersion(prefix);

                const environment = api.createPythonEnvironmentItem(
                    await getPrefixesCondaPythonInfo(prefix, path.join(prefix, bin), version, await getConda()),
                    manager,
                );
                return environment;
            } catch (e) {
                log.error('Failed to create conda environment', e);
                setImmediate(async () => {
                    await showErrorMessageWithLogs(CondaStrings.condaCreateFailed, log);
                });
            }
        },
    );
}

export async function generateName(fsPath: string): Promise<string | undefined> {
    let attempts = 0;
    while (attempts < 5) {
        const randomStr = Math.random().toString(36).substring(2);
        const name = `env_${randomStr}`;
        const prefix = path.join(fsPath, name);
        if (!(await fse.exists(prefix))) {
            return name;
        }
    }
    return undefined;
}

export async function quickCreateConda(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    fsPath: string,
    name: string,
    additionalPackages?: string[],
): Promise<PythonEnvironment | undefined> {
    const prefix = path.join(fsPath, name);

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: `Creating conda environment: ${name}`,
        },
        async () => {
            try {
                const bin = os.platform() === 'win32' ? 'python.exe' : 'python';
                await runCondaExecutable(['create', '--yes', '--prefix', prefix, 'python'], log);
                if (additionalPackages && additionalPackages.length > 0) {
                    await runConda(['install', '--yes', '--prefix', prefix, ...additionalPackages], log);
                }
                const version = await getVersion(prefix);

                const environment = api.createPythonEnvironmentItem(
                    {
                        name: path.basename(prefix),
                        environmentPath: Uri.file(prefix),
                        displayName: `${version} (${name})`,
                        displayPath: prefix,
                        description: prefix,
                        version,
                        execInfo: {
                            run: { executable: path.join(prefix, bin) },
                            activatedRun: {
                                executable: 'conda',
                                args: ['run', '--live-stream', '-p', prefix, 'python'],
                            },
                            activation: [{ executable: 'conda', args: ['activate', prefix] }],
                            deactivation: [{ executable: 'conda', args: ['deactivate'] }],
                        },
                        sysPrefix: prefix,
                        group: 'Prefix',
                    },
                    manager,
                );
                return environment;
            } catch (e) {
                log.error('Failed to create conda environment', e);
                setImmediate(async () => {
                    await showErrorMessageWithLogs(CondaStrings.condaCreateFailed, log);
                });
            }
        },
    );
}

export async function deleteCondaEnvironment(environment: PythonEnvironment, log: LogOutputChannel): Promise<boolean> {
    let args = ['env', 'remove', '--yes', '--prefix', environment.environmentPath.fsPath];
    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: l10n.t('Deleting conda environment: {0}', environment.environmentPath.fsPath),
        },
        async () => {
            try {
                await runCondaExecutable(args, log);
            } catch (e) {
                log.error(`Failed to delete conda environment: ${e}`);
                setImmediate(async () => {
                    await showErrorMessageWithLogs(CondaStrings.condaRemoveFailed, log);
                });
                return false;
            }
            return true;
        },
    );
}

export async function refreshPackages(
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    manager: PackageManager,
): Promise<Package[]> {
    let args = ['list', '-p', environment.environmentPath.fsPath];
    const data = await runCondaExecutable(args);
    const content = data.split(/\r?\n/).filter((l) => !l.startsWith('#'));
    const packages: Package[] = [];
    content.forEach((l) => {
        const parts = l.split(' ').filter((p) => p.length > 0);
        if (parts.length >= 3) {
            const pkg = api.createPackageItem(
                {
                    name: parts[0],
                    displayName: parts[0],
                    version: parts[1],
                    description: parts[1],
                },
                environment,
                manager,
            );
            packages.push(pkg);
        }
    });
    return packages;
}

export async function managePackages(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
    api: PythonEnvironmentApi,
    manager: PackageManager,
    token: CancellationToken,
    log: LogOutputChannel,
): Promise<Package[]> {
    if (options.uninstall && options.uninstall.length > 0) {
        await runCondaExecutable(
            ['remove', '--prefix', environment.environmentPath.fsPath, '--yes', ...options.uninstall],
            log,
            token,
        );
    }
    if (options.install && options.install.length > 0) {
        const args = ['install', '--prefix', environment.environmentPath.fsPath, '--yes'];
        if (options.upgrade) {
            args.push('--update-all');
        }
        args.push(...options.install);
        await runCondaExecutable(args, log, token);
    }
    return refreshPackages(environment, api, manager);
}

async function getCommonPackages(): Promise<Installable[]> {
    try {
        const pipData = path.join(EXTENSION_ROOT_DIR, 'files', 'conda_packages.json');
        const data = await fse.readFile(pipData, { encoding: 'utf-8' });
        const packages = JSON.parse(data) as { name: string; description: string; uri: string }[];

        return packages.map((p) => {
            return {
                name: p.name,
                displayName: p.name,
                uri: Uri.parse(p.uri),
                description: p.description,
            };
        });
    } catch {
        return [];
    }
}

interface CondaPackagesResult {
    install: string[];
    uninstall: string[];
}

async function selectCommonPackagesOrSkip(
    common: Installable[],
    installed: string[],
    showSkipOption: boolean,
): Promise<CondaPackagesResult | undefined> {
    if (common.length === 0) {
        return undefined;
    }

    const items: QuickPickItem[] = [];
    if (common.length > 0) {
        items.push({
            label: PackageManagement.searchCommonPackages,
            description: PackageManagement.searchCommonPackagesDescription,
        });
    }

    if (showSkipOption && items.length > 0) {
        items.push({ label: PackageManagement.skipPackageInstallation });
    }

    let showBackButton = true;
    let selected: QuickPickItem[] | QuickPickItem | undefined = undefined;
    if (items.length === 1) {
        selected = items[0];
        showBackButton = false;
    } else {
        selected = await showQuickPickWithButtons(items, {
            placeHolder: Pickers.Packages.selectOption,
            ignoreFocusOut: true,
            showBackButton: true,
            matchOnDescription: false,
            matchOnDetail: false,
        });
    }

    if (selected && !Array.isArray(selected)) {
        try {
            if (selected.label === PackageManagement.searchCommonPackages) {
                return await selectFromCommonPackagesToInstall(common, installed, undefined, { showBackButton });
            } else {
                traceInfo('Package Installer: user selected skip package installation');
                return undefined;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (ex: any) {
            if (ex === QuickInputButtons.Back) {
                return selectCommonPackagesOrSkip(common, installed, showSkipOption);
            }
        }
    }
    return undefined;
}

export async function getCommonCondaPackagesToInstall(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
    api: PythonEnvironmentApi,
): Promise<CondaPackagesResult | undefined> {
    const common = await getCommonPackages();
    const installed = (await api.getPackages(environment))?.map((p) => p.name);
    const selected = await selectCommonPackagesOrSkip(common, installed ?? [], !!options.showSkipOption);
    return selected;
}

async function installPython(
    nativeFinder: NativePythonFinder,
    manager: EnvironmentManager,
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
): Promise<PythonEnvironment | undefined> {
    if (environment.sysPrefix === '') {
        return undefined;
    }
    await runCondaExecutable(['install', '--yes', '--prefix', environment.sysPrefix, 'python'], log);
    await nativeFinder.refresh(true, NativePythonEnvironmentKind.conda);
    const native = await nativeFinder.resolve(environment.sysPrefix);
    if (native.kind === NativePythonEnvironmentKind.conda) {
        return nativeToPythonEnv(native, api, manager, log, await getConda(), await getPrefixes());
    }
    return undefined;
}

export async function checkForNoPythonCondaEnvironment(
    nativeFinder: NativePythonFinder,
    manager: EnvironmentManager,
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
): Promise<PythonEnvironment | undefined> {
    if (environment.version === 'no-python') {
        if (environment.sysPrefix === '') {
            await showErrorMessage(CondaStrings.condaMissingPythonNoFix, { modal: true });
            return undefined;
        } else {
            const result = await showErrorMessage(
                `${CondaStrings.condaMissingPython}: ${environment.displayName}`,
                {
                    modal: true,
                },
                Common.installPython,
            );
            if (result === Common.installPython) {
                return await installPython(nativeFinder, manager, environment, api, log);
            }
            return undefined;
        }
    }
    return environment;
}

// Cache for conda hook paths to avoid redundant filesystem checks
const condaHookPathCache = new Map<string, Promise<string>>();

/**
 * Returns the best guess path to conda-hook.ps1 given a conda executable path.
 *
 * Searches for conda-hook.ps1 in these locations (relative to the conda root):
 *   - shell/condabin/
 *   - Library/shell/condabin/
 *   - condabin/
 *   - etc/profile.d/
 */
async function getCondaHookPs1Path(condaPath: string): Promise<string> {
    // Check cache first
    const cachedPath = condaHookPathCache.get(condaPath);
    if (cachedPath) {
        return cachedPath;
    }

    // Create the promise for finding the hook path
    const hookPathPromise = (async () => {
        const condaRoot = path.dirname(path.dirname(condaPath));

        const condaRootCandidates: string[] = [
            path.join(condaRoot, 'shell', 'condabin'),
            path.join(condaRoot, 'Library', 'shell', 'condabin'),
            path.join(condaRoot, 'condabin'),
            path.join(condaRoot, 'etc', 'profile.d'),
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
        traceError(
            `Conda hook not found in any of the expected locations: ${condaRootCandidates.join(
                ', ',
            )}, given conda path: ${condaPath}`,
        );
        return path.join(condaRoot, 'shell', 'condabin', 'conda-hook.ps1');
    })();

    // Store in cache and return
    condaHookPathCache.set(condaPath, hookPathPromise);
    return hookPathPromise;
}
