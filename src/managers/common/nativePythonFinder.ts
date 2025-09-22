import * as ch from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PassThrough } from 'stream';
import { Disposable, ExtensionContext, LogOutputChannel, Uri, workspace } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { PythonProjectApi } from '../../api';
import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../../common/constants';
import { getExtension } from '../../common/extension.apis';
import { traceVerbose, traceLog } from '../../common/logging';
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
 * Gets all custom virtual environment locations to look for environments.
 */
function getCustomVirtualEnvDirs(): string[] {
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
 * Extracts the environment directory from a Python executable path.
 * This follows the pattern: executable -> bin -> env -> search directory
 * @param executablePath Path to Python executable
 * @returns The environment directory path, or undefined if not found
 */
function extractEnvironmentDirectory(executablePath: string): string | undefined {
    try {
        const environmentDir = path.dirname(path.dirname(path.dirname(executablePath)));
        if (environmentDir && environmentDir !== path.dirname(environmentDir)) {
            traceLog('Extracted environment directory:', environmentDir, 'from executable:', executablePath);
            return environmentDir;
        } else {
            traceLog('Warning: identified executable python at', executablePath, 'not configured in correct folder structure, skipping');
            return undefined;
        }
    } catch (error) {
        traceLog('Error extracting environment directory from:', executablePath, 'Error:', error);
        return undefined;
    }
}

/**
 * Gets all extra environment search paths from various configuration sources.
 * Combines legacy python settings (with migration), python-env.searchPaths settings.
 * @returns Array of search directory paths
 */
async function getAllExtraSearchPaths(): Promise<string[]> {
    const searchDirectories: string[] = [];
    
    // Get custom virtual environment directories from legacy python settings
    const customVenvDirs = getCustomVirtualEnvDirs();
    searchDirectories.push(...customVenvDirs);
    traceLog('Added legacy custom venv directories:', customVenvDirs);
    
    // Handle migration from legacy python settings to python-env.searchPaths
    await handleLegacyPythonSettingsMigration();
    
    // Get searchPaths using proper VS Code settings precedence
    const searchPaths = getSearchPathsWithPrecedence();
    traceLog('Retrieved searchPaths with precedence:', searchPaths);

    for (const searchPath of searchPaths) {
        try {
            if (!searchPath || searchPath.trim() === '') {
                continue;
            }

            const trimmedPath = searchPath.trim();
            
            // Check if it's a regex pattern (contains regex special characters)
            // Note: Windows paths contain backslashes, so we need to be more careful
            const regexChars = /[*?[\]{}()^$+|\\]/;
            const hasBackslash = trimmedPath.includes('\\');
            const isWindowsPath = hasBackslash && (trimmedPath.match(/^[A-Za-z]:\\/) || trimmedPath.match(/^\\\\[^\\]+\\/));
            const isRegexPattern = regexChars.test(trimmedPath) && !isWindowsPath;
            
            if (isRegexPattern) {
                traceLog('Processing regex pattern for Python environment discovery:', trimmedPath);
                traceLog('Warning: Using regex patterns in searchPaths may cause performance issues due to file system scanning');
                
                // Use workspace.findFiles to search with the regex pattern as literally as possible
                const foundFiles = await workspace.findFiles(trimmedPath, null);
                traceLog('Regex pattern search found', foundFiles.length, 'files matching pattern:', trimmedPath);
                
                for (const file of foundFiles) {
                    const filePath = file.fsPath;
                    traceLog('Evaluating file from regex search:', filePath);
                    
                    // Extract environment directory from the found file path
                    const environmentDir = extractEnvironmentDirectory(filePath);
                    if (environmentDir) {
                        searchDirectories.push(environmentDir);
                        traceLog('Added search directory from regex match:', environmentDir);
                    }
                }
                
                traceLog('Completed processing regex pattern:', trimmedPath, 'Added', searchDirectories.length, 'search directories');
            }
            // Check if it's a directory path
            else if (await fs.pathExists(trimmedPath) && (await fs.stat(trimmedPath)).isDirectory()) {
                traceLog('Processing directory path:', trimmedPath);
                searchDirectories.push(trimmedPath);
                traceLog('Added directory as search path:', trimmedPath);
            }
            // Path doesn't exist yet - might be created later (virtual envs, network drives, symlinks)
            else {
                traceLog('Path does not exist currently, adding for future resolution:', trimmedPath);
                searchDirectories.push(trimmedPath);
            }
        } catch (error) {
            traceLog('Error processing search path:', searchPath, 'Error:', error);
        }
    }

    // Remove duplicates and return
    const uniquePaths = Array.from(new Set(searchDirectories));
    traceLog('getAllExtraSearchPaths completed. Total unique search directories:', uniquePaths.length, 'Paths:', uniquePaths);
    return uniquePaths;
}

/**
 * Gets searchPaths setting value using proper VS Code settings precedence.
 * Checks workspaceFolder, then workspace, then user level settings.
 * @returns Array of search paths from the most specific scope available
 */
function getSearchPathsWithPrecedence(): string[] {
    try {
        // Use VS Code configuration inspection to handle precedence automatically
        const config = getConfiguration('python-env');
        const inspection = config.inspect<string[]>('searchPaths');
        
        // VS Code automatically handles precedence: workspaceFolder -> workspace -> user
        // We check each level in order and return the first one found
        if (inspection?.workspaceFolderValue) {
            traceLog('Using workspaceFolder level searchPaths setting');
            return untildifyArray(inspection.workspaceFolderValue);
        }
        
        if (inspection?.workspaceValue) {
            traceLog('Using workspace level searchPaths setting');
            return untildifyArray(inspection.workspaceValue);
        }
        
        if (inspection?.globalValue) {
            traceLog('Using user level searchPaths setting');
            return untildifyArray(inspection.globalValue);
        }
        
        // Default empty array
        traceLog('No searchPaths setting found at any level, using empty array');
        return [];
    } catch (error) {
        traceLog('Error getting searchPaths with precedence:', error);
        return [];
    }
}

/**
 * Applies untildify to an array of paths
 * @param paths Array of potentially tilde-containing paths
 * @returns Array of expanded paths
 */
function untildifyArray(paths: string[]): string[] {
    return paths.map(p => untildify(p));
}

/**
 * Handles migration from legacy python settings (python.venvPath and python.venvFolders) to python-env.searchPaths.
 * Only migrates if legacy settings exist and searchPaths is different.
 */
async function handleLegacyPythonSettingsMigration(): Promise<void> {
    try {
        const pythonConfig = getConfiguration('python');
        const envConfig = getConfiguration('python-env');
        
        // Get legacy settings
        const venvPathInspection = pythonConfig.inspect<string>('venvPath');
        const venvPath = venvPathInspection?.globalValue;
        
        const venvFoldersInspection = pythonConfig.inspect<string[]>('venvFolders');
        const venvFolders = venvFoldersInspection?.globalValue || [];
        
        // Collect all legacy paths
        const legacyPaths: string[] = [];
        if (venvPath) {
            legacyPaths.push(venvPath);
        }
        legacyPaths.push(...venvFolders);
        
        if (legacyPaths.length === 0) {
            return;
        }
        
        traceLog('Found legacy python settings - venvPath:', venvPath, 'venvFolders:', venvFolders);
        
        // Check current searchPaths at user level
        const searchPathsInspection = envConfig.inspect<string[]>('searchPaths');
        const currentSearchPaths = searchPathsInspection?.globalValue || [];
        
        // Check if they are the same (no need to migrate)
        if (arraysEqual(legacyPaths, currentSearchPaths)) {
            traceLog('Legacy settings and searchPaths are identical, no migration needed');
            return;
        }
        
        // Combine legacy paths with existing searchPaths (remove duplicates)
        const combinedPaths = Array.from(new Set([...currentSearchPaths, ...legacyPaths]));
        
        // Update searchPaths at user level
        await envConfig.update('searchPaths', combinedPaths, true); // true = global/user level
        
        // Delete the old legacy settings
        if (venvPath) {
            await pythonConfig.update('venvPath', undefined, true);
        }
        if (venvFolders.length > 0) {
            await pythonConfig.update('venvFolders', undefined, true);
        }
        
        traceLog('Migrated legacy python settings to searchPaths and removed old settings. Combined paths:', combinedPaths);
        
        // Show notification to user about migration
        // Note: We should only show this once per session to avoid spam
        if (!migrationNotificationShown) {
            migrationNotificationShown = true;
            // Note: Actual notification would use VS Code's window.showInformationMessage
            // but we'll log it for now since we can't import window APIs here
            const settingsRemoved = [venvPath ? 'python.venvPath' : '', venvFolders.length > 0 ? 'python.venvFolders' : ''].filter(Boolean).join(' and ');
            traceLog(`User notification: Automatically migrated ${settingsRemoved} to python-env.searchPaths and removed the old settings.`);
        }
    } catch (error) {
        traceLog('Error during legacy python settings migration:', error);
    }
}

/**
 * Helper function to compare two arrays for equality
 */
function arraysEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((val, index) => val === b[index]);
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
