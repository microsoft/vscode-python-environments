import * as ch from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PassThrough } from 'stream';
import { Disposable, ExtensionContext, LogOutputChannel, Uri, workspace } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { PythonProjectApi } from '../../api';
import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../../common/constants';
import { getExtension } from '../../common/extension.apis';
import { traceLog, traceVerbose } from '../../common/logging';
import { untildify } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import { createRunningWorkerPool, WorkerPool } from '../../common/utils/workerPool';
import { getConfiguration } from '../../common/workspace.apis';
import { noop } from './utils';

export async function getNativePythonToolsPath(): Promise<string> {
    const envsExt = getExtension(ENVS_EXTENSION_ID);
    if (envsExt) {
        const petPath = path.join(envsExt.extensionPath, 'python-env-tools', 'bin', isWindows() ? 'pet.exe' : 'pet');
        if (await fs.pathExists(petPath)) {
            return petPath;
        }
    }

    const python = getExtension(PYTHON_EXTENSION_ID);
    if (!python) {
        throw new Error('Python extension not found');
    }

    return path.join(python.extensionPath, 'python-env-tools', 'bin', isWindows() ? 'pet.exe' : 'pet');
}

export interface NativeEnvInfo {
    displayName?: string;
    name?: string;
    executable?: string;
    kind?: NativePythonEnvironmentKind;
    version?: string;
    prefix?: string;
    manager?: NativeEnvManagerInfo;
    project?: string;
    arch?: 'x64' | 'x86';
    symlinks?: string[];
}

export interface NativeEnvManagerInfo {
    tool: string;
    executable: string;
    version?: string;
}

export type NativeInfo = NativeEnvInfo | NativeEnvManagerInfo;

export function isNativeEnvInfo(info: NativeInfo): boolean {
    return !(info as NativeEnvManagerInfo).tool;
}

export enum NativePythonEnvironmentKind {
    conda = 'Conda',
    homebrew = 'Homebrew',
    pyenv = 'Pyenv',
    globalPaths = 'GlobalPaths',
    pyenvVirtualEnv = 'PyenvVirtualEnv',
    pipenv = 'Pipenv',
    poetry = 'Poetry',
    macPythonOrg = 'MacPythonOrg',
    macCommandLineTools = 'MacCommandLineTools',
    linuxGlobal = 'LinuxGlobal',
    macXCode = 'MacXCode',
    venv = 'Venv',
    virtualEnv = 'VirtualEnv',
    virtualEnvWrapper = 'VirtualEnvWrapper',
    windowsStore = 'WindowsStore',
    windowsRegistry = 'WindowsRegistry',
}

export interface NativePythonFinder extends Disposable {
    /**
     * Refresh the list of python environments.
     * Returns an async iterable that can be used to iterate over the list of python environments.
     * Internally this will take all of the current workspace folders and search for python environments.
     *
     * If a Uri is provided, then it will search for python environments in that location (ignoring workspaces).
     * Uri can be a file or a folder.
     * If a NativePythonEnvironmentKind is provided, then it will search for python environments of that kind (ignoring workspaces).
     */
    refresh(hardRefresh: boolean, options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]>;
    /**
     * Will spawn the provided Python executable and return information about the environment.
     * @param executable
     */
    resolve(executable: string): Promise<NativeEnvInfo>;
}
interface NativeLog {
    level: string;
    message: string;
}

interface RefreshOptions {
    searchKind?: NativePythonEnvironmentKind;
    searchPaths?: string[];
}

class NativePythonFinderImpl implements NativePythonFinder {
    private readonly connection: rpc.MessageConnection;
    private readonly pool: WorkerPool<NativePythonEnvironmentKind | Uri[] | undefined, NativeInfo[]>;
    private cache: Map<string, NativeInfo[]> = new Map();

    constructor(
        private readonly outputChannel: LogOutputChannel,
        private readonly toolPath: string,
        private readonly api: PythonProjectApi,
        private readonly cacheDirectory?: Uri,
    ) {
        this.connection = this.start();
        this.pool = createRunningWorkerPool<NativePythonEnvironmentKind | Uri[] | undefined, NativeInfo[]>(
            async (options) => await this.doRefresh(options),
            1,
            'NativeRefresh-task',
        );
    }

    public async resolve(executable: string): Promise<NativeEnvInfo> {
        await this.configure();
        const environment = await this.connection.sendRequest<NativeEnvInfo>('resolve', {
            executable,
        });

        this.outputChannel.info(`Resolved Python Environment ${environment.executable}`);
        return environment;
    }

    public async refresh(hardRefresh: boolean, options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        if (hardRefresh) {
            return this.handleHardRefresh(options);
        }
        return this.handleSoftRefresh(options);
    }

    private getKey(options?: NativePythonEnvironmentKind | Uri[]): string {
        if (options === undefined) {
            return 'all';
        }
        if (typeof options === 'string') {
            return options;
        }
        if (Array.isArray(options)) {
            return options.map((item) => item.fsPath).join(',');
        }
        return 'all';
    }

    private async handleHardRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const key = this.getKey(options);
        this.cache.delete(key);
        if (!options) {
            traceVerbose('Finder - refreshing all environments');
        } else {
            traceVerbose('Finder - from cache environments', key);
        }
        const result = await this.pool.addToQueue(options);
        this.cache.set(key, result);
        return result;
    }

    private async handleSoftRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const key = this.getKey(options);
        const cacheResult = this.cache.get(key);
        if (!cacheResult) {
            return this.handleHardRefresh(options);
        }

        if (!options) {
            traceVerbose('Finder - from cache refreshing all environments');
        } else {
            traceVerbose('Finder - from cache environments', key);
        }
        return cacheResult;
    }

    public dispose() {
        this.connection.dispose();
    }

    private getRefreshOptions(options?: NativePythonEnvironmentKind | Uri[]): RefreshOptions | undefined {
        // settings on where else to search
        const venvFolders = getPythonSettingAndUntildify<string[]>('venvFolders') ?? [];
        if (options) {
            if (typeof options === 'string') {
                // kind
                return { searchKind: options };
            }
            if (Array.isArray(options)) {
                const uriSearchPaths = options.map((item) => item.fsPath);
                uriSearchPaths.push(...venvFolders);
                return { searchPaths: uriSearchPaths };
            }
        }
        // return undefined to use configured defaults (for nativeFinder refresh)
        return undefined;
    }

    private start(): rpc.MessageConnection {
        this.outputChannel.info(`[pet] Starting Python Locator ${this.toolPath} server`);

        // jsonrpc package cannot handle messages coming through too quickly.
        // Lets handle the messages and close the stream only when
        // we have got the exit event.
        const readable = new PassThrough();
        const writable = new PassThrough();
        const disposables: Disposable[] = [];
        try {
            const proc = ch.spawn(this.toolPath, ['server'], { env: process.env });
            proc.stdout.pipe(readable, { end: false });
            proc.stderr.on('data', (data) => this.outputChannel.error(`[pet] ${data.toString()}`));
            writable.pipe(proc.stdin, { end: false });

            disposables.push({
                dispose: () => {
                    try {
                        if (proc.exitCode === null) {
                            proc.kill();
                        }
                    } catch (ex) {
                        this.outputChannel.error('[pet] Error disposing finder', ex);
                    }
                },
            });
        } catch (ex) {
            this.outputChannel.error(`[pet] Error starting Python Finder ${this.toolPath} server`, ex);
        }
        const connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(readable),
            new rpc.StreamMessageWriter(writable),
        );
        disposables.push(
            connection,
            new Disposable(() => {
                readable.end();
                writable.end();
            }),
            connection.onError((ex) => {
                this.outputChannel.error('[pet] Connection Error:', ex);
            }),
            connection.onNotification('log', (data: NativeLog) => {
                const msg = `[pet] ${data.message}`;
                switch (data.level) {
                    case 'info':
                        this.outputChannel.info(msg);
                        break;
                    case 'warning':
                        this.outputChannel.warn(msg);
                        break;
                    case 'error':
                        this.outputChannel.error(msg);
                        break;
                    case 'debug':
                        this.outputChannel.debug(msg);
                        break;
                    default:
                        this.outputChannel.trace(msg);
                }
            }),
            connection.onNotification('telemetry', (data) => this.outputChannel.info('[pet] Telemetry: ', data)),
            connection.onClose(() => {
                disposables.forEach((d) => d.dispose());
            }),
        );

        connection.listen();
        return connection;
    }

    private async doRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const disposables: Disposable[] = [];
        const unresolved: Promise<void>[] = [];
        const nativeInfo: NativeInfo[] = [];
        try {
            await this.configure();
            const refreshOptions = this.getRefreshOptions(options);
            disposables.push(
                this.connection.onNotification('environment', (data: NativeEnvInfo) => {
                    this.outputChannel.info(`Discovered env: ${data.executable || data.prefix}`);
                    if (data.executable && (!data.version || !data.prefix)) {
                        unresolved.push(
                            this.connection
                                .sendRequest<NativeEnvInfo>('resolve', {
                                    executable: data.executable,
                                })
                                .then((environment: NativeEnvInfo) => {
                                    this.outputChannel.info(
                                        `Resolved environment during PET refresh: ${environment.executable}`,
                                    );
                                    nativeInfo.push(environment);
                                })
                                .catch((ex) =>
                                    this.outputChannel.error(`Error in Resolving ${JSON.stringify(data)}`, ex),
                                ),
                        );
                    } else {
                        nativeInfo.push(data);
                    }
                }),
                this.connection.onNotification('manager', (data: NativeEnvManagerInfo) => {
                    this.outputChannel.info(`Discovered manager: (${data.tool}) ${data.executable}`);
                    nativeInfo.push(data);
                }),
            );
            await this.connection.sendRequest<{ duration: number }>('refresh', refreshOptions);
            await Promise.all(unresolved);
        } catch (ex) {
            this.outputChannel.error('[pet] Error refreshing', ex);
            throw ex;
        } finally {
            disposables.forEach((d) => d.dispose());
        }

        return nativeInfo;
    }

    private lastConfiguration?: ConfigurationOptions;

    /**
     * Configuration request, this must always be invoked before any other request.
     * Must be invoked when ever there are changes to any data related to the configuration details.
     */
    private async configure() {
        // Get all extra search paths including legacy settings and new searchPaths
        const extraSearchPaths = await getAllExtraSearchPaths();

        traceLog('Final environment directories:', extraSearchPaths);

        const options: ConfigurationOptions = {
            workspaceDirectories: this.api.getPythonProjects().map((item) => item.uri.fsPath),
            environmentDirectories: extraSearchPaths,
            condaExecutable: getPythonSettingAndUntildify<string>('condaPath'),
            poetryExecutable: getPythonSettingAndUntildify<string>('poetryPath'),
            cacheDirectory: this.cacheDirectory?.fsPath,
        };
        // No need to send a configuration request, is there are no changes.
        if (JSON.stringify(options) === JSON.stringify(this.lastConfiguration || {})) {
            this.outputChannel.debug('[pet] configure: No changes detected, skipping configuration update.');
            return;
        }
        this.outputChannel.info('[pet] configure: Sending configuration update:', JSON.stringify(options));
        try {
            this.lastConfiguration = options;
            await this.connection.sendRequest('configure', options);
        } catch (ex) {
            this.outputChannel.error('[pet] configure: Configuration error', ex);
        }
    }
}

type ConfigurationOptions = {
    workspaceDirectories: string[];
    environmentDirectories: string[];
    condaExecutable: string | undefined;
    poetryExecutable: string | undefined;
    cacheDirectory?: string;
};
/**
 * Gets all custom virtual environment locations to look for environments from the legacy python settings (venvPath, venvFolders).
 */
function getCustomVirtualEnvDirsLegacy(): string[] {
    const venvDirs: string[] = [];
    const venvPath = getPythonSettingAndUntildify<string>('venvPath');
    if (venvPath) {
        venvDirs.push(untildify(venvPath));
    }
    const venvFolders = getPythonSettingAndUntildify<string[]>('venvFolders') ?? [];
    venvFolders.forEach((item) => {
        venvDirs.push(item);
    });
    return Array.from(new Set(venvDirs));
}

function getPythonSettingAndUntildify<T>(name: string, scope?: Uri): T | undefined {
    const value = getConfiguration('python', scope).get<T>(name);
    if (typeof value === 'string') {
        return value ? (untildify(value as string) as unknown as T) : undefined;
    }
    return value;
}

/**
 * Checks if a search path is a regex pattern.
 * A path is considered a regex pattern if it contains regex special characters
 * but is not a Windows path (which can contain backslashes).
 * @param searchPath The search path to check
 * @returns true if the path is a regex pattern, false otherwise
 */
function isRegexSearchPattern(searchPath: string): boolean {
    // Check if it's a regex pattern (contains regex special characters)
    // Note: Windows paths contain backslashes, so we need to be more careful
    const regexChars = /[*?[\]{}()^$+|\\]/;
    const hasBackslash = searchPath.includes('\\');
    const isWindowsPath = hasBackslash && (searchPath.match(/^[A-Za-z]:\\/) || searchPath.match(/^\\\\[^\\]+\\/));
    return regexChars.test(searchPath) && !isWindowsPath;
}

/**
 * Extracts the environment directory from a Python executable path.
 * This follows the pattern: executable -> bin -> env -> search directory
 * @param executablePath Path to Python executable
 * @returns The environment directory path, or undefined if not found
 */
function extractEnvironmentDirectory(executablePath: string): string | undefined {
    try {
        // TODO: This logic may need to be adjusted for Windows paths (esp with Conda as doesn't use Scripts folder?)
        const environmentDir = path.dirname(path.dirname(path.dirname(executablePath)));
        if (environmentDir && environmentDir !== path.dirname(environmentDir)) {
            traceLog('Extracted environment directory:', environmentDir, 'from executable:', executablePath);
            return environmentDir;
        } else {
            traceLog(
                'Warning: identified executable python at',
                executablePath,
                'not configured in correct folder structure, skipping',
            );
            return undefined;
        }
    } catch (error) {
        traceLog('Error extracting environment directory from:', executablePath, 'Error:', error);
        return undefined;
    }
}

/**
 * Gets all extra environment search paths from various configuration sources.
 * Combines legacy python settings (with migration), globalSearchPaths, and workspaceSearchPaths.
 * @returns Array of search directory paths
 */
async function getAllExtraSearchPaths(): Promise<string[]> {
    const searchDirectories: string[] = [];

    // Handle migration from legacy python settings to new search paths settings
    const legacyPathsCovered = await handleLegacyPythonSettingsMigration();

    // Only get legacy custom venv directories if they haven't been migrated to globalSearchPaths correctly
    if (!legacyPathsCovered) {
        const customVenvDirs = getCustomVirtualEnvDirsLegacy();
        searchDirectories.push(...customVenvDirs);
        traceLog('Added legacy custom venv directories (not covered by globalSearchPaths):', customVenvDirs);
    } else {
        traceLog('Skipping legacy custom venv directories - they are covered by globalSearchPaths');
    }

    // Get globalSearchPaths (absolute paths, no regex)
    const globalSearchPaths = getGlobalSearchPaths();
    traceLog('Retrieved globalSearchPaths:', globalSearchPaths);
    for (const globalPath of globalSearchPaths) {
        try {
            if (!globalPath || globalPath.trim() === '') {
                continue;
            }
            const trimmedPath = globalPath.trim();
            traceLog('Processing global search path:', trimmedPath);
            // Simply add the trimmed global path
            searchDirectories.push(trimmedPath);
        } catch (error) {
            traceLog('Error processing global search path:', globalPath, 'Error:', error);
        }
    }

    // Get workspaceSearchPaths (can include regex patterns)
    const workspaceSearchPaths = getWorkspaceSearchPaths();
    traceLog('Retrieved workspaceSearchPaths:', workspaceSearchPaths);
    for (const searchPath of workspaceSearchPaths) {
        try {
            if (!searchPath || searchPath.trim() === '') {
                continue;
            }

            const trimmedPath = searchPath.trim();
            const isRegexPattern = isRegexSearchPattern(trimmedPath);

            if (isRegexPattern) {
                // Search for Python executables using the regex pattern
                // Look for common Python executable names within the pattern
                const pythonExecutablePatterns = isWindows()
                    ? [`${trimmedPath}/**/python.exe`, `${trimmedPath}/**/python3.exe`]
                    : [`${trimmedPath}/**/python`, `${trimmedPath}/**/python3`];

                traceLog('Searching for Python executables with patterns:', pythonExecutablePatterns);
                for (const pattern of pythonExecutablePatterns) {
                    try {
                        const foundFiles = await workspace.findFiles(pattern, null);
                        traceLog(
                            'Python executable search found',
                            foundFiles.length,
                            'files matching pattern:',
                            pattern,
                        );

                        for (const file of foundFiles) {
                            // given the executable path, extract and save the environment directory
                            const environmentDir = extractEnvironmentDirectory(file.fsPath);
                            if (environmentDir) {
                                searchDirectories.push(environmentDir);
                            }
                        }
                    } catch (error) {
                        traceLog('Error searching for Python executables with pattern:', pattern, 'Error:', error);
                    }
                }
            } else {
                // If it's not a regex, treat it as a normal directory path and just add it
                searchDirectories.push(trimmedPath);
            }
        } catch (error) {
            traceLog('Error processing workspace search path:', searchPath, 'Error:', error);
        }
    }

    // Remove duplicates and return
    const uniquePaths = Array.from(new Set(searchDirectories));
    traceLog(
        'getAllExtraSearchPaths completed. Total unique search directories:',
        uniquePaths.length,
        'Paths:',
        uniquePaths,
    );
    return uniquePaths;
}

/**
 * Gets globalSearchPaths setting with proper validation.
 * Only gets user-level (global) setting since this setting is application-scoped.
 */
function getGlobalSearchPaths(): string[] {
    try {
        const envConfig = getConfiguration('python-env');
        const inspection = envConfig.inspect<string[]>('globalSearchPaths');

        const globalPaths = inspection?.globalValue || [];
        traceLog('Retrieved globalSearchPaths:', globalPaths);
        return untildifyArray(globalPaths);
    } catch (error) {
        traceLog('Error getting globalSearchPaths:', error);
        return [];
    }
}

/**
 * Gets workspaceSearchPaths setting with workspace precedence.
 * Gets the most specific workspace-level setting available.
 */
function getWorkspaceSearchPaths(): string[] {
    try {
        const envConfig = getConfiguration('python-env');
        const inspection = envConfig.inspect<string[]>('workspaceSearchPaths');

        // For workspace settings, prefer workspaceFolder > workspace
        if (inspection?.workspaceFolderValue) {
            traceLog('Using workspaceFolder level workspaceSearchPaths setting');
            return inspection.workspaceFolderValue;
        }

        if (inspection?.workspaceValue) {
            traceLog('Using workspace level workspaceSearchPaths setting');
            return inspection.workspaceValue;
        }

        // Default empty array (don't use global value for workspace settings)
        traceLog('No workspaceSearchPaths setting found at workspace level, using empty array');
        return [];
    } catch (error) {
        traceLog('Error getting workspaceSearchPaths:', error);
        return [];
    }
}

/**
 * Applies untildify to an array of paths
 * @param paths Array of potentially tilde-containing paths
 * @returns Array of expanded paths
 */
function untildifyArray(paths: string[]): string[] {
    return paths.map((p) => untildify(p));
}

/**
 * Handles migration from legacy python settings to the new globalSearchPaths setting.
 * Legacy settings (venvPath, venvFolders) are User-scoped only, so they all migrate to globalSearchPaths.
 * Does NOT delete the old settings, only adds them to the new settings.
 * @returns true if legacy paths are covered by globalSearchPaths (either already there or just migrated), false if legacy paths should be included separately
 */
async function handleLegacyPythonSettingsMigration(): Promise<boolean> {
    try {
        const pythonConfig = getConfiguration('python');
        const envConfig = getConfiguration('python-env');

        // Get legacy settings at global level only (they were User-scoped)
        const venvPathInspection = pythonConfig.inspect<string>('venvPath');
        const venvFoldersInspection = pythonConfig.inspect<string[]>('venvFolders');

        // Collect global (user-level) legacy paths for globalSearchPaths
        const globalLegacyPaths: string[] = [];
        if (venvPathInspection?.globalValue) {
            globalLegacyPaths.push(venvPathInspection.globalValue);
        }
        if (venvFoldersInspection?.globalValue) {
            globalLegacyPaths.push(...venvFoldersInspection.globalValue);
        }

        if (globalLegacyPaths.length === 0) {
            // No legacy settings exist, so they're "covered" (nothing to worry about)
            traceLog('No legacy python settings found');
            return true;
        }

        traceLog('Found legacy python settings - global paths:', globalLegacyPaths);

        // Check if legacy paths are already in globalSearchPaths
        const globalSearchPathsInspection = envConfig.inspect<string[]>('globalSearchPaths');
        const currentGlobalSearchPaths = globalSearchPathsInspection?.globalValue || [];

        // Check if all legacy paths are already covered by globalSearchPaths
        const legacyPathsAlreadyCovered = globalLegacyPaths.every((legacyPath) =>
            currentGlobalSearchPaths.includes(legacyPath),
        );

        if (legacyPathsAlreadyCovered) {
            traceLog('All legacy paths are already in globalSearchPaths, no migration needed');
            return true; // Legacy paths are covered
        }

        // Need to migrate - add legacy paths to globalSearchPaths
        const combinedGlobalPaths = Array.from(new Set([...currentGlobalSearchPaths, ...globalLegacyPaths]));
        await envConfig.update('globalSearchPaths', combinedGlobalPaths, true); // true = global/user level
        traceLog('Migrated legacy global python settings to globalSearchPaths. Combined paths:', combinedGlobalPaths);

        // Show notification to user about migration
        if (!migrationNotificationShown) {
            migrationNotificationShown = true;
            traceLog(
                'User notification: Automatically migrated legacy python settings to python-env.globalSearchPaths.',
            );
        }

        return true; // Legacy paths are now covered by globalSearchPaths
    } catch (error) {
        traceLog('Error during legacy python settings migration:', error);
        return false; // On error, include legacy paths separately to be safe
    }
}

// Module-level variable to track migration notification
let migrationNotificationShown = false;

export function getCacheDirectory(context: ExtensionContext): Uri {
    return Uri.joinPath(context.globalStorageUri, 'pythonLocator');
}

export async function clearCacheDirectory(context: ExtensionContext): Promise<void> {
    const cacheDirectory = getCacheDirectory(context);
    await fs.emptyDir(cacheDirectory.fsPath).catch(noop);
}

export async function createNativePythonFinder(
    outputChannel: LogOutputChannel,
    api: PythonProjectApi,
    context: ExtensionContext,
): Promise<NativePythonFinder> {
    return new NativePythonFinderImpl(outputChannel, await getNativePythonToolsPath(), api, getCacheDirectory(context));
}
