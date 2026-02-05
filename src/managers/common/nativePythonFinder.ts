import { ChildProcess } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PassThrough } from 'stream';
import { CancellationTokenSource, Disposable, ExtensionContext, LogOutputChannel, Uri } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { PythonProjectApi } from '../../api';
import { spawnProcess } from '../../common/childProcess.apis';
import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../../common/constants';
import { getExtension } from '../../common/extension.apis';
import { traceError, traceLog, traceWarn } from '../../common/logging';
import { untildify, untildifyArray } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import { createRunningWorkerPool, WorkerPool } from '../../common/utils/workerPool';
import { getConfiguration, getWorkspaceFolders } from '../../common/workspace.apis';
import { noop } from './utils';

// Timeout constants for JSON-RPC requests (in milliseconds)
const CONFIGURE_TIMEOUT_MS = 30_000; // 30 seconds for configuration
const REFRESH_TIMEOUT_MS = 120_000; // 2 minutes for full refresh
const RESOLVE_TIMEOUT_MS = 30_000; // 30 seconds for single resolve

// Restart/recovery constants
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 1_000; // 1 second base, exponential: 1s, 2s, 4s

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
    /**
     * Error message if the environment is broken or invalid.
     * This is reported by PET when detecting issues like broken symlinks or missing executables.
     */
    error?: string;
}

export interface NativeEnvManagerInfo {
    tool: string;
    executable: string;
    version?: string;
}

export type NativeInfo = NativeEnvInfo | NativeEnvManagerInfo;

export function isNativeEnvInfo(info: NativeInfo): info is NativeEnvInfo {
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
    uvWorkspace = 'UvWorkspace',
    venv = 'Venv',
    venvUv = 'Uv',
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

/**
 * Wraps a JSON-RPC sendRequest call with a timeout.
 * @param connection The JSON-RPC connection
 * @param method The RPC method name
 * @param params The parameters to send
 * @param timeoutMs Timeout in milliseconds
 * @returns The result of the request
 * @throws Error if the request times out
 */
async function sendRequestWithTimeout<T>(
    connection: rpc.MessageConnection,
    method: string,
    params: unknown,
    timeoutMs: number,
): Promise<T> {
    const cts = new CancellationTokenSource();
    const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
            cts.cancel();
            reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Clear timeout if the CancellationTokenSource is disposed
        cts.token.onCancellationRequested(() => clearTimeout(timer));
    });

    try {
        return await Promise.race([connection.sendRequest<T>(method, params, cts.token), timeoutPromise]);
    } finally {
        cts.dispose();
    }
}

class NativePythonFinderImpl implements NativePythonFinder {
    private connection: rpc.MessageConnection;
    private readonly pool: WorkerPool<NativePythonEnvironmentKind | Uri[] | undefined, NativeInfo[]>;
    private cache: Map<string, NativeInfo[]> = new Map();
    private startDisposables: Disposable[] = [];
    private proc: ChildProcess | undefined;
    private processExited: boolean = false;
    private startFailed: boolean = false;
    private restartAttempts: number = 0;
    private isRestarting: boolean = false;

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
        await this.ensureProcessRunning();
        try {
            await this.configure();
            const environment = await sendRequestWithTimeout<NativeEnvInfo>(
                this.connection,
                'resolve',
                { executable },
                RESOLVE_TIMEOUT_MS,
            );

            this.outputChannel.info(`Resolved Python Environment ${environment.executable}`);
            // Reset restart attempts on successful request
            this.restartAttempts = 0;
            return environment;
        } catch (ex) {
            // On timeout, kill the hung process so next request triggers restart
            if (ex instanceof Error && ex.message.includes('timed out')) {
                this.outputChannel.warn('[pet] Resolve request timed out, killing hung process for restart');
                this.killProcess();
                this.processExited = true;
            }
            throw ex;
        }
    }

    /**
     * Ensures the PET process is running. If it has exited or failed, attempts to restart
     * with exponential backoff up to MAX_RESTART_ATTEMPTS times.
     * @throws Error if the process cannot be started after all retry attempts
     */
    private async ensureProcessRunning(): Promise<void> {
        // Process is running fine
        if (!this.startFailed && !this.processExited) {
            return;
        }

        // Already in the process of restarting (prevent recursive restarts)
        if (this.isRestarting) {
            throw new Error('Python Environment Tools (PET) is currently restarting. Please try again.');
        }

        // Check if we've exceeded max restart attempts
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            throw new Error(
                `Python Environment Tools (PET) failed after ${MAX_RESTART_ATTEMPTS} restart attempts. ` +
                    'Please reload the window or check the output channel for details. ' +
                    'To debug, run "Python Environments: Run Python Environment Tool (PET) in Terminal" from the Command Palette.',
            );
        }

        // Attempt restart with exponential backoff
        await this.restart();
    }

    /**
     * Kills the current PET process (if running) and starts a fresh one.
     * Implements exponential backoff between restart attempts.
     */
    private async restart(): Promise<void> {
        this.isRestarting = true;
        this.restartAttempts++;

        const backoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts - 1);
        this.outputChannel.warn(
            `[pet] Restarting Python Environment Tools (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}, ` +
                `waiting ${backoffMs}ms)`,
        );

        try {
            // Kill existing process if still running
            this.killProcess();

            // Dispose existing connection and streams
            this.startDisposables.forEach((d) => d.dispose());
            this.startDisposables = [];

            // Wait with exponential backoff before restarting
            await new Promise((resolve) => setTimeout(resolve, backoffMs));

            // Reset state flags
            this.processExited = false;
            this.startFailed = false;
            this.lastConfiguration = undefined; // Force reconfiguration

            // Start fresh
            this.connection = this.start();

            this.outputChannel.info('[pet] Python Environment Tools restarted successfully');

            // Reset restart attempts on successful start (process didn't immediately fail)
            // We'll reset this only after a successful request completes
        } catch (ex) {
            this.outputChannel.error('[pet] Failed to restart Python Environment Tools:', ex);
            this.outputChannel.error(
                '[pet] To debug, run "Python Environments: Run Python Environment Tool (PET) in Terminal" from the Command Palette.',
            );
            throw ex;
        } finally {
            this.isRestarting = false;
        }
    }

    /**
     * Attempts to kill the PET process. Used during restart and timeout recovery.
     */
    private killProcess(): void {
        if (this.proc && this.proc.exitCode === null) {
            try {
                this.outputChannel.info('[pet] Killing hung/crashed PET process');
                this.proc.kill('SIGTERM');
                // Give it a moment to terminate gracefully, then force kill
                setTimeout(() => {
                    if (this.proc && this.proc.exitCode === null) {
                        this.proc.kill('SIGKILL');
                    }
                }, 500);
            } catch (ex) {
                this.outputChannel.error('[pet] Error killing process:', ex);
            }
        }
        this.proc = undefined;
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
            // Use null character as separator to avoid collisions with paths containing commas
            return options.map((item) => item.fsPath).join('\0');
        }
        return 'all';
    }

    private async handleHardRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const key = this.getKey(options);
        this.cache.delete(key);
        if (!options) {
            this.outputChannel.debug('[Finder] Refreshing all environments');
        } else {
            this.outputChannel.debug(`[Finder] Hard refresh for key: ${key}`);
        }
        const result = await this.pool.addToQueue(options);
        // Validate result from worker pool
        if (!result || !Array.isArray(result)) {
            this.outputChannel.warn(`[pet] Worker pool returned invalid result type: ${typeof result}`);
            return [];
        }
        this.cache.set(key, result);
        return result;
    }

    private async handleSoftRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const key = this.getKey(options);
        const cacheResult = this.cache.get(key);
        // Validate cache integrity - if cached value is not a valid array, do a hard refresh
        if (!cacheResult || !Array.isArray(cacheResult)) {
            if (cacheResult !== undefined) {
                this.outputChannel.warn(`[pet] Cache contained invalid data type: ${typeof cacheResult}`);
                this.cache.delete(key);
            }
            return this.handleHardRefresh(options);
        }

        if (!options) {
            this.outputChannel.debug('[Finder] Returning cached environments for all');
        } else {
            this.outputChannel.debug(`[Finder] Returning cached environments for key: ${key}`);
        }
        return cacheResult;
    }

    public dispose() {
        this.pool.stop();
        this.startDisposables.forEach((d) => d.dispose());
        this.connection.dispose();
    }

    private getRefreshOptions(options?: NativePythonEnvironmentKind | Uri[]): RefreshOptions | undefined {
        // Note: venvFolders is also fetched in getAllExtraSearchPaths() for configure().
        // This duplication is intentional: when searchPaths is provided to the native finder,
        // it may override (not supplement) the configured environmentDirectories.
        // We must include venvFolders here to ensure they're always searched during targeted refreshes.
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

        try {
            this.proc = spawnProcess(this.toolPath, ['server'], { env: process.env, stdio: 'pipe' });

            if (!this.proc.stdout || !this.proc.stderr || !this.proc.stdin) {
                throw new Error('Failed to create stdio streams for PET process');
            }

            this.proc.stdout.pipe(readable, { end: false });
            this.proc.stderr.on('data', (data) => this.outputChannel.error(`[pet] ${data.toString()}`));
            writable.pipe(this.proc.stdin, { end: false });

            // Handle process exit - mark as exited so pending requests fail fast
            this.proc.on('exit', (code, signal) => {
                this.processExited = true;
                if (code !== 0) {
                    this.outputChannel.error(
                        `[pet] Python Environment Tools exited unexpectedly with code ${code}, signal ${signal}`,
                    );
                }
            });

            // Handle process errors (e.g., ENOENT if executable not found)
            this.proc.on('error', (err) => {
                this.processExited = true;
                this.outputChannel.error('[pet] Process error:', err);
            });

            const proc = this.proc;
            this.startDisposables.push({
                dispose: () => {
                    try {
                        if (proc.exitCode === null) {
                            // Attempt graceful shutdown by closing stdin before killing
                            // This gives the process a chance to clean up
                            this.outputChannel.debug('[pet] Shutting down Python Locator server');
                            proc.stdin?.end();
                            // Give process a moment to exit gracefully, then force kill
                            setTimeout(() => {
                                if (proc.exitCode === null) {
                                    proc.kill();
                                }
                            }, 500);
                        }
                    } catch (ex) {
                        this.outputChannel.error('[pet] Error disposing finder', ex);
                    }
                },
            });
        } catch (ex) {
            // Mark start as failed so all subsequent requests fail immediately
            this.startFailed = true;
            this.outputChannel.error(`[pet] Error starting Python Finder ${this.toolPath} server`, ex);
            this.outputChannel.error(
                '[pet] To debug, run "Python Environments: Run Python Environment Tool (PET) in Terminal" from the Command Palette.',
            );
            // Don't continue - throw so caller knows spawn failed
            throw ex;
        }
        const connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(readable),
            new rpc.StreamMessageWriter(writable),
        );
        this.startDisposables.push(
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
                this.startDisposables.forEach((d) => d.dispose());
            }),
        );

        connection.listen();
        return connection;
    }

    private async doRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        await this.ensureProcessRunning();
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
                            sendRequestWithTimeout<NativeEnvInfo>(
                                this.connection,
                                'resolve',
                                { executable: data.executable },
                                RESOLVE_TIMEOUT_MS,
                            )
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
            await sendRequestWithTimeout<{ duration: number }>(
                this.connection,
                'refresh',
                refreshOptions,
                REFRESH_TIMEOUT_MS,
            );
            await Promise.all(unresolved);

            // Reset restart attempts on successful refresh
            this.restartAttempts = 0;
        } catch (ex) {
            // On timeout, kill the hung process so next request triggers restart
            if (ex instanceof Error && ex.message.includes('timed out')) {
                this.outputChannel.warn('[pet] Request timed out, killing hung process for restart');
                this.killProcess();
                this.processExited = true;
            }
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

        const options: ConfigurationOptions = {
            workspaceDirectories: this.api.getPythonProjects().map((item) => item.uri.fsPath),
            environmentDirectories: extraSearchPaths,
            condaExecutable: getPythonSettingAndUntildify<string>('condaPath'),
            pipenvExecutable: getPythonSettingAndUntildify<string>('pipenvPath'),
            poetryExecutable: getPythonSettingAndUntildify<string>('poetryPath'),
            cacheDirectory: this.cacheDirectory?.fsPath,
        };
        // No need to send a configuration request if there are no changes.
        if (this.lastConfiguration && this.configurationEquals(options, this.lastConfiguration)) {
            this.outputChannel.debug('[pet] configure: No changes detected, skipping configuration update.');
            return;
        }
        this.outputChannel.info('[pet] configure: Sending configuration update:', JSON.stringify(options));
        try {
            this.lastConfiguration = options;
            await sendRequestWithTimeout(this.connection, 'configure', options, CONFIGURE_TIMEOUT_MS);
        } catch (ex) {
            // On timeout, kill the hung process so next request triggers restart
            if (ex instanceof Error && ex.message.includes('timed out')) {
                this.outputChannel.warn('[pet] Configure request timed out, killing hung process for restart');
                this.killProcess();
                this.processExited = true;
            }
            this.outputChannel.error('[pet] configure: Configuration error', ex);
            throw ex;
        }
    }

    /**
     * Compares two ConfigurationOptions objects for equality.
     * Uses property-by-property comparison to avoid issues with JSON.stringify
     * (property order, undefined values serialization).
     */
    private configurationEquals(a: ConfigurationOptions, b: ConfigurationOptions): boolean {
        // Compare simple optional string properties
        if (a.condaExecutable !== b.condaExecutable) {
            return false;
        }
        if (a.pipenvExecutable !== b.pipenvExecutable) {
            return false;
        }
        if (a.poetryExecutable !== b.poetryExecutable) {
            return false;
        }
        if (a.cacheDirectory !== b.cacheDirectory) {
            return false;
        }

        // Compare array properties using sorted comparison to handle order differences
        const arraysEqual = (arr1: string[], arr2: string[]): boolean => {
            if (arr1.length !== arr2.length) {
                return false;
            }
            const sorted1 = [...arr1].sort();
            const sorted2 = [...arr2].sort();
            return sorted1.every((val, idx) => val === sorted2[idx]);
        };

        if (!arraysEqual(a.workspaceDirectories, b.workspaceDirectories)) {
            return false;
        }
        if (!arraysEqual(a.environmentDirectories, b.environmentDirectories)) {
            return false;
        }

        return true;
    }
}

type ConfigurationOptions = {
    workspaceDirectories: string[];
    environmentDirectories: string[];
    condaExecutable: string | undefined;
    pipenvExecutable: string | undefined;
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
 * Gets all extra environment search paths from various configuration sources.
 * Combines legacy python settings (with migration), globalSearchPaths, and workspaceSearchPaths.
 * @returns Array of search directory paths
 */
export async function getAllExtraSearchPaths(): Promise<string[]> {
    const searchDirectories: string[] = [];

    // add legacy custom venv directories
    const customVenvDirs = getCustomVirtualEnvDirsLegacy();
    searchDirectories.push(...customVenvDirs);

    // Get globalSearchPaths
    const globalSearchPaths = getGlobalSearchPaths().filter((path) => path && path.trim() !== '');
    searchDirectories.push(...globalSearchPaths);

    // Get workspaceSearchPaths
    const workspaceSearchPaths = getWorkspaceSearchPaths();

    // Resolve relative paths against workspace folders
    for (const searchPath of workspaceSearchPaths) {
        if (!searchPath || searchPath.trim() === '') {
            continue;
        }

        const trimmedPath = searchPath.trim();

        if (path.isAbsolute(trimmedPath)) {
            // Absolute path - use as is
            searchDirectories.push(trimmedPath);
        } else {
            // Relative path - resolve against all workspace folders
            const workspaceFolders = getWorkspaceFolders();
            if (workspaceFolders) {
                for (const workspaceFolder of workspaceFolders) {
                    const resolvedPath = path.resolve(workspaceFolder.uri.fsPath, trimmedPath);
                    searchDirectories.push(resolvedPath);
                }
            } else {
                traceWarn('Warning: No workspace folders found for relative path:', trimmedPath);
            }
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
        const envConfig = getConfiguration('python-envs');
        const inspection = envConfig.inspect<string[]>('globalSearchPaths');

        const globalPaths = inspection?.globalValue || [];
        return untildifyArray(globalPaths);
    } catch (error) {
        traceError('Error getting globalSearchPaths:', error);
        return [];
    }
}

/**
 * Gets the most specific workspace-level setting available for workspaceSearchPaths.
 */
function getWorkspaceSearchPaths(): string[] {
    try {
        const envConfig = getConfiguration('python-envs');
        const inspection = envConfig.inspect<string[]>('workspaceSearchPaths');

        if (inspection?.globalValue) {
            traceError(
                'Error: python-envs.workspaceSearchPaths is set at the user/global level, but this setting can only be set at the workspace or workspace folder level.',
            );
        }

        // For workspace settings, prefer workspaceFolder > workspace
        if (inspection?.workspaceFolderValue) {
            return inspection.workspaceFolderValue;
        }

        if (inspection?.workspaceValue) {
            return inspection.workspaceValue;
        }

        // Default empty array (don't use global value for workspace settings)
        return [];
    } catch (error) {
        traceError('Error getting workspaceSearchPaths:', error);
        return [];
    }
}

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
