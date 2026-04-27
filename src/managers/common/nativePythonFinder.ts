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
import { traceError, traceVerbose, traceWarn } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { untildify, untildifyArray } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import { createRunningWorkerPool, WorkerPool } from '../../common/utils/workerPool';
import { getConfiguration, getWorkspaceFolders } from '../../common/workspace.apis';
import { noop } from './utils';

// Timeout constants for JSON-RPC requests (in milliseconds)
const CONFIGURE_TIMEOUT_MS = 30_000; // 30 seconds for configuration
const MAX_CONFIGURE_TIMEOUT_MS = 60_000; // Max configure timeout after retries (60s)
const REFRESH_TIMEOUT_MS = 30_000; // 30 seconds for full refresh (with 1 retry = 60s max)
const RESOLVE_TIMEOUT_MS = 30_000; // 30 seconds for single resolve

// CLI fallback timeout: generous budget since it's a full process spawn doing a full scan
const CLI_FALLBACK_TIMEOUT_MS = 120_000; // 2 minutes
// Limit concurrent resolve subprocesses to avoid CPU/memory pressure on machines with many envs
const CLI_RESOLVE_CONCURRENCY = 4;

// Restart/recovery constants
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 1_000; // 1 second base, exponential: 1s, 2s, 4s
const MAX_CONFIGURE_TIMEOUTS_BEFORE_KILL = 2; // Kill on the 2nd consecutive timeout
const MAX_REFRESH_RETRIES = 1; // Retry refresh once after timeout

/**
 * Computes the configure timeout with exponential backoff.
 * @param retryCount Number of consecutive configure timeouts so far
 * @returns Timeout in milliseconds: 30s, 60s, capped at MAX_CONFIGURE_TIMEOUT_MS (60s)
 */
export function getConfigureTimeoutMs(retryCount: number): number {
    return Math.min(CONFIGURE_TIMEOUT_MS * Math.pow(2, retryCount), MAX_CONFIGURE_TIMEOUT_MS);
}

/**
 * Encapsulates the configure retry state machine.
 * Tracks consecutive timeout count and decides whether to kill the process.
 */
export class ConfigureRetryState {
    private _timeoutCount: number = 0;

    get timeoutCount(): number {
        return this._timeoutCount;
    }

    /** Returns the timeout duration for the current attempt (with exponential backoff). */
    getTimeoutMs(): number {
        return getConfigureTimeoutMs(this._timeoutCount);
    }

    /** Call after a successful configure. Resets the timeout counter. */
    onSuccess(): void {
        this._timeoutCount = 0;
    }

    /**
     * Call after a configure timeout. Increments the counter and returns
     * whether the process should be killed (true = kill, false = let it continue).
     */
    onTimeout(): boolean {
        this._timeoutCount++;
        if (this._timeoutCount >= MAX_CONFIGURE_TIMEOUTS_BEFORE_KILL) {
            this._timeoutCount = 0;
            return true; // Kill the process
        }
        return false; // Let PET continue
    }

    /** Call after a non-timeout error or process restart. Resets the counter. */
    reset(): void {
        this._timeoutCount = 0;
    }
}

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
    pixi = 'Pixi',
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
    winpython = 'WinPython',
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
 * Error thrown when a JSON-RPC request times out.
 */
export class RpcTimeoutError extends Error {
    constructor(
        public readonly method: string,
        timeoutMs: number,
    ) {
        super(`Request '${method}' timed out after ${timeoutMs}ms`);
        this.name = this.constructor.name;
    }
}

/**
 * Wraps a JSON-RPC sendRequest call with a timeout.
 * @param connection The JSON-RPC connection
 * @param method The RPC method name
 * @param params The parameters to send
 * @param timeoutMs Timeout in milliseconds
 * @returns The result of the request
 * @throws RpcTimeoutError if the request times out
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
            reject(new RpcTimeoutError(method, timeoutMs));
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
    private readonly configureRetry = new ConfigureRetryState();

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
        const sw = new StopWatch();
        try {
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
                sendTelemetryEvent(EventNames.PET_RESOLVE, sw.elapsedTime, { result: 'success' });
                return environment;
            } catch (ex) {
                // On resolve timeout or connection error (not configure — configure handles its own timeout),
                // kill the hung process so next request triggers restart
                if ((ex instanceof RpcTimeoutError && ex.method !== 'configure') || ex instanceof rpc.ConnectionError) {
                    const reason = ex instanceof rpc.ConnectionError ? 'crashed' : 'timed out';
                    this.outputChannel.warn(`[pet] Resolve request ${reason}, killing process for restart`);
                    this.killProcess();
                    this.processExited = true;
                }
                throw ex;
            }
        } catch (ex) {
            const errorType = classifyError(ex);
            sendTelemetryEvent(
                EventNames.PET_RESOLVE,
                sw.elapsedTime,
                {
                    result: errorType === 'spawn_timeout' ? 'timeout' : 'error',
                    errorType,
                },
                ex instanceof Error ? ex : undefined,
            );
            // If the server mode is fully exhausted, fall back to the CLI JSON mode
            if (this.isServerExhausted()) {
                this.outputChannel.warn('[pet] Server mode exhausted, falling back to JSON CLI for resolve');
                return this.resolveViaJsonCli(executable);
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
        const attempt = this.restartAttempts;

        const backoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts - 1);
        this.outputChannel.warn(
            `[pet] Restarting Python Environment Tools (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}, ` +
                `waiting ${backoffMs}ms)`,
        );

        const sw = new StopWatch();
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
            this.configureRetry.reset();

            // Start fresh
            this.connection = this.start();

            this.outputChannel.info('[pet] Python Environment Tools restarted successfully');
            sendTelemetryEvent(EventNames.PET_PROCESS_RESTART, sw.elapsedTime, { attempt, result: 'success' });

            // Reset restart attempts on successful start (process didn't immediately fail)
            // We'll reset this only after a successful request completes
        } catch (ex) {
            sendTelemetryEvent(
                EventNames.PET_PROCESS_RESTART,
                sw.elapsedTime,
                { attempt, result: 'error', errorType: classifyError(ex) },
                ex instanceof Error ? ex : undefined,
            );
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

    private getRefreshOptions(options?: NativePythonEnvironmentKind | Uri[]): RefreshOptions {
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
        // return empty object to use configured defaults (for nativeFinder refresh)
        return {};
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
        let lastError: unknown;

        for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
            try {
                return await this.doRefreshAttempt(options, attempt);
            } catch (ex) {
                lastError = ex;

                // Retry on timeout or connection errors (PET hung or crashed mid-request)
                const isRetryable =
                    (ex instanceof RpcTimeoutError && ex.method !== 'configure') || ex instanceof rpc.ConnectionError;
                if (isRetryable) {
                    if (attempt < MAX_REFRESH_RETRIES) {
                        const reason = ex instanceof rpc.ConnectionError ? 'crashed' : 'timed out';
                        this.outputChannel.warn(
                            `[pet] Refresh ${reason} (attempt ${attempt + 1}/${MAX_REFRESH_RETRIES + 1}), restarting and retrying...`,
                        );
                        // Kill and restart for retry
                        this.killProcess();
                        this.processExited = true;
                        continue;
                    }
                    // Final attempt failed
                    this.outputChannel.error(`[pet] Refresh failed after ${MAX_REFRESH_RETRIES + 1} attempts`);
                }
                // Non-timeout errors or final timeout — check if server is fully exhausted
                if (this.isServerExhausted()) {
                    this.outputChannel.warn('[pet] Server mode exhausted, falling back to JSON CLI for refresh');
                    return this.refreshViaJsonCli(options);
                }
                throw ex;
            }
        }

        // Should not reach here, but TypeScript needs this
        if (this.isServerExhausted()) {
            this.outputChannel.warn('[pet] Server mode exhausted, falling back to JSON CLI for refresh (final)');
            return this.refreshViaJsonCli(options);
        }
        throw lastError;
    }

    private async doRefreshAttempt(
        options: NativePythonEnvironmentKind | Uri[] | undefined,
        attempt: number,
    ): Promise<NativeInfo[]> {
        await this.ensureProcessRunning();
        const disposables: Disposable[] = [];
        const unresolved: Promise<void>[] = [];
        const nativeInfo: NativeInfo[] = [];
        const sw = new StopWatch();
        let unresolvedCount = 0;
        try {
            await this.configure();
            const refreshOptions = this.getRefreshOptions(options);
            const workspaceDirCount = this.lastConfiguration?.workspaceDirectories.length ?? 0;
            const searchPathCount = this.lastConfiguration?.environmentDirectories.length ?? 0;
            disposables.push(
                this.connection.onNotification('environment', (data: NativeEnvInfo) => {
                    this.outputChannel.info(`Discovered env: ${data.executable || data.prefix}`);
                    if (data.executable && (!data.version || !data.prefix)) {
                        unresolvedCount++;
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
            if (attempt > 0) {
                this.outputChannel.info(`[pet] Refresh succeeded on retry attempt ${attempt + 1}`);
            }

            sendTelemetryEvent(EventNames.PET_REFRESH, sw.elapsedTime, {
                result: 'success',
                envCount: nativeInfo.filter((e) => isNativeEnvInfo(e)).length,
                unresolvedCount,
                workspaceDirCount,
                searchPathCount,
                attempt,
            });
        } catch (ex) {
            const errorType = classifyError(ex);
            sendTelemetryEvent(
                EventNames.PET_REFRESH,
                sw.elapsedTime,
                {
                    result: errorType === 'spawn_timeout' ? 'timeout' : 'error',
                    envCount: nativeInfo.filter((e) => isNativeEnvInfo(e)).length,
                    unresolvedCount,
                    attempt,
                    errorType,
                },
                ex instanceof Error ? ex : undefined,
            );
            // On refresh timeout or connection error (not configure — configure handles its own timeout),
            // kill the hung process so next request triggers restart
            if ((ex instanceof RpcTimeoutError && ex.method !== 'configure') || ex instanceof rpc.ConnectionError) {
                const reason = ex instanceof rpc.ConnectionError ? 'crashed' : 'timed out';
                this.outputChannel.warn(`[pet] PET process ${reason}, killing for restart`);
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
        const options = await this.buildConfigurationOptions();
        // No need to send a configuration request if there are no changes.
        if (this.lastConfiguration && this.configurationEquals(options, this.lastConfiguration)) {
            this.outputChannel.debug('[pet] configure: No changes detected, skipping configuration update.');
            sendTelemetryEvent(EventNames.PET_CONFIGURE, 0, { result: 'skipped', retryCount: 0 });
            return;
        }
        this.outputChannel.info('[pet] configure: Sending configuration update:', JSON.stringify(options));
        // Exponential backoff: 30s, 60s on retry. Capped at REFRESH_TIMEOUT_MS.
        const timeoutMs = this.configureRetry.getTimeoutMs();
        if (this.configureRetry.timeoutCount > 0) {
            this.outputChannel.info(
                `[pet] configure: Using extended timeout of ${timeoutMs}ms (retry ${this.configureRetry.timeoutCount})`,
            );
        }
        const sw = new StopWatch();
        const retryCount = this.configureRetry.timeoutCount;
        const workspaceDirCount = options.workspaceDirectories.length;
        const envDirCount = options.environmentDirectories.length;
        try {
            await sendRequestWithTimeout(this.connection, 'configure', options, timeoutMs);
            // Only cache after success so failed/timed-out calls will retry
            this.lastConfiguration = options;
            this.configureRetry.onSuccess();
            sendTelemetryEvent(EventNames.PET_CONFIGURE, sw.elapsedTime, {
                result: 'success',
                workspaceDirCount,
                envDirCount,
                retryCount,
            });
        } catch (ex) {
            sendTelemetryEvent(
                EventNames.PET_CONFIGURE,
                sw.elapsedTime,
                {
                    result: ex instanceof RpcTimeoutError ? 'timeout' : 'error',
                    workspaceDirCount,
                    envDirCount,
                    retryCount,
                },
                ex instanceof Error ? ex : undefined,
            );
            // Clear cached config so the next call retries instead of short-circuiting via configurationEquals
            this.lastConfiguration = undefined;
            if (ex instanceof RpcTimeoutError) {
                const shouldKill = this.configureRetry.onTimeout();
                if (shouldKill) {
                    this.outputChannel.error(
                        '[pet] Configure timed out on consecutive attempts, killing hung process for restart',
                    );
                    this.killProcess();
                    this.processExited = true;
                } else {
                    this.outputChannel.warn(
                        `[pet] Configure request timed out (attempt ${this.configureRetry.timeoutCount}/${MAX_CONFIGURE_TIMEOUTS_BEFORE_KILL}), ` +
                            'will retry on next request without killing process',
                    );
                }
            } else {
                // Non-timeout errors reset the counter so only consecutive timeouts are counted
                this.configureRetry.reset();
                this.outputChannel.error('[pet] configure: Configuration error', ex);
            }
            throw ex;
        }
    }

    /**
     * Builds the current ConfigurationOptions from VS Code settings and the active workspace.
     * Extracted from configure() so the CLI fallback can build the same config.
     */
    private async buildConfigurationOptions(): Promise<ConfigurationOptions> {
        // Get all extra search paths including legacy settings and new searchPaths
        const extraSearchPaths = await getAllExtraSearchPaths();
        return {
            workspaceDirectories: this.api.getPythonProjects().map((item) => item.uri.fsPath),
            environmentDirectories: extraSearchPaths,
            condaExecutable: getPythonSettingAndUntildify<string>('condaPath'),
            pipenvExecutable: getPythonSettingAndUntildify<string>('pipenvPath'),
            poetryExecutable: getPythonSettingAndUntildify<string>('poetryPath'),
            cacheDirectory: this.cacheDirectory?.fsPath,
        };
    }

    /**
     * Returns true when all server restart attempts have been exhausted.
     * Used to decide whether to fall back to CLI mode.
     * Does NOT return true while a restart is in progress — the server is not exhausted
     * if it is still mid-restart (concurrent callers must not bypass to CLI prematurely).
     */
    private isServerExhausted(): boolean {
        return (
            !this.isRestarting &&
            this.restartAttempts >= MAX_RESTART_ATTEMPTS &&
            (this.startFailed || this.processExited)
        );
    }

    /**
     * Spawns the PET binary with the given args and collects its stdout.
     * Uses direct spawn (not shell) to avoid injection risks from user-supplied paths.
     * Kills the process after `timeoutMs` to prevent hangs.
     *
     * @param args Arguments to pass to the PET binary.
     * @param timeoutMs Maximum time to wait for the process to complete.
     * @returns The stdout string.
     */
    private runPetCliProcess(args: string[], timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawnProcess(this.toolPath, args, { stdio: 'pipe' });
            let stdout = '';
            // Guard against settling the promise more than once.
            // The timeout handler and the 'close'/'error' handlers can both fire
            // (e.g. timeout fires → SIGTERM sent → close event fires shortly after).
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    proc.kill('SIGTERM');
                    // Force kill after a short grace period if still running
                    setTimeout(() => {
                        if (proc.exitCode === null) {
                            proc.kill('SIGKILL');
                        }
                    }, 500);
                } catch {
                    // Ignore kill errors
                }
                reject(new Error(`PET CLI process timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            proc.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });
            proc.stderr.on('data', (data: Buffer) => {
                // PET writes diagnostics/logs to stderr in --json mode; surface them as debug
                this.outputChannel.debug(`[pet CLI] ${data.toString().trimEnd()}`);
            });
            proc.on('close', (code) => {
                if (settled) {
                    return;
                }
                clearTimeout(timer);
                settled = true;
                // If the process failed and produced no output, reject so caller gets a clear error
                if (code !== 0 && stdout.trim().length === 0) {
                    reject(new Error(`PET CLI process exited with code ${code}`));
                    return;
                }
                if (code !== 0) {
                    this.outputChannel.warn(
                        `[pet CLI] Process exited with code ${code} but produced output; using output`,
                    );
                }
                resolve(stdout);
            });
            proc.on('error', (err) => {
                if (settled) {
                    return;
                }
                clearTimeout(timer);
                settled = true;
                reject(err);
            });
        });
    }

    /**
     * Fallback environment refresh using `pet find --json`.
     * Invoked when the JSON-RPC server mode is exhausted after all restart attempts.
     * Spawns PET as a one-shot subprocess and parses the JSON output.
     *
     * @param options Optional kind filter or URI search paths (same semantics as refresh()).
     * @returns NativeInfo[] containing managers and environments, same as server mode.
     */
    private async refreshViaJsonCli(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const config = await this.buildConfigurationOptions();
        // venvFolders must be included explicitly as search paths when options is Uri[],
        // mirroring getRefreshOptions() server-mode behaviour (searchPaths may override environmentDirectories).
        const venvFolders = getPythonSettingAndUntildify<string[]>('venvFolders') ?? [];
        const args = buildFindCliArgs(config, options, venvFolders);

        this.outputChannel.info(`[pet] JSON CLI fallback refresh: ${this.toolPath} ${args.join(' ')}`);
        const stopWatch = new StopWatch();

        let stdout: string;
        try {
            stdout = await this.runPetCliProcess(args, CLI_FALLBACK_TIMEOUT_MS);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'refresh',
                result: 'error',
            });
            this.outputChannel.error('[pet] JSON CLI fallback refresh failed:', ex);
            throw ex;
        }

        let parsed: { managers: NativeEnvManagerInfo[]; environments: NativeEnvInfo[] };
        try {
            parsed = parseRefreshCliOutput(stdout);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'refresh',
                result: 'error',
            });
            this.outputChannel.error(
                `[pet] JSON CLI fallback: Failed to parse find output (first 500 chars): ${stdout.slice(0, 500)}`,
                ex,
            );
            const cause = ex instanceof Error ? `: ${ex.message}` : '';
            throw new Error(`Failed to parse PET find --json output${cause}`);
        }

        const nativeInfo: NativeInfo[] = [];

        for (const manager of parsed.managers ?? []) {
            this.outputChannel.info(`[pet CLI] Discovered manager: (${manager.tool}) ${manager.executable}`);
            nativeInfo.push(manager);
        }

        // Collect environments that need individual resolve calls.
        // Incomplete environments have an executable but are missing version or prefix.
        const toResolve: NativeEnvInfo[] = [];
        for (const env of parsed.environments ?? []) {
            if (env.executable && (!env.version || !env.prefix)) {
                toResolve.push(env);
            } else {
                this.outputChannel.info(`[pet CLI] Discovered env: ${env.executable ?? env.prefix}`);
                nativeInfo.push(env);
            }
        }

        // Resolve incomplete environments with bounded concurrency to avoid spawning too many
        // subprocesses at once on machines with many incomplete environments.
        // Each resolveViaJsonCli() spawns a new OS process, unlike server mode where all resolve
        // calls share a single long-lived process — so unbounded parallelism would cause CPU/memory
        // pressure. Process in batches of CLI_RESOLVE_CONCURRENCY.
        for (let i = 0; i < toResolve.length; i += CLI_RESOLVE_CONCURRENCY) {
            const batch = toResolve.slice(i, i + CLI_RESOLVE_CONCURRENCY);
            await Promise.all(
                batch.map((env) =>
                    this.resolveViaJsonCli(env.executable!)
                        .then((resolved) => {
                            this.outputChannel.info(`[pet CLI] Resolved env: ${resolved.executable}`);
                            nativeInfo.push(resolved);
                        })
                        .catch(() => {
                            // If resolve fails, still include the partial env so nothing is silently dropped
                            this.outputChannel.warn(
                                `[pet CLI] Could not resolve incomplete env, using partial data: ${env.executable}`,
                            );
                            nativeInfo.push(env);
                        }),
                ),
            );
        }

        sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
            operation: 'refresh',
            result: 'success',
        });
        return nativeInfo;
    }

    /**
     * Fallback environment resolution using `pet resolve <exe> --json`.
     * Invoked when the JSON-RPC server mode is exhausted after all restart attempts.
     *
     * @param executable Path to the Python executable to resolve.
     * @returns The resolved NativeEnvInfo.
     * @throws Error if PET cannot identify the environment or if the output cannot be parsed.
     */
    private async resolveViaJsonCli(executable: string): Promise<NativeEnvInfo> {
        const args = ['resolve', executable, '--json'];
        if (this.cacheDirectory) {
            args.push('--cache-directory', this.cacheDirectory.fsPath);
        }

        this.outputChannel.info(`[pet] JSON CLI fallback resolve: ${this.toolPath} ${args.join(' ')}`);
        const stopWatch = new StopWatch();

        let stdout: string;
        try {
            stdout = await this.runPetCliProcess(args, CLI_FALLBACK_TIMEOUT_MS);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'resolve',
                result: 'error',
            });
            this.outputChannel.error('[pet] JSON CLI fallback resolve failed:', ex);
            throw ex;
        }

        let parsed: NativeEnvInfo;
        try {
            parsed = parseResolveCliOutput(stdout.trim(), executable);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'resolve',
                result: 'error',
            });
            if (ex instanceof SyntaxError) {
                this.outputChannel.error(
                    '[pet] JSON CLI fallback: Failed to parse resolve output:',
                    stdout.slice(0, 200),
                );
                throw new Error(`Failed to parse PET resolve --json output for ${executable}`);
            }
            // "not found" (null) or other parse error
            throw ex;
        }

        sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
            operation: 'resolve',
            result: 'success',
        });
        return parsed;
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

export type ConfigurationOptions = {
    workspaceDirectories: string[];
    environmentDirectories: string[];
    condaExecutable: string | undefined;
    pipenvExecutable: string | undefined;
    poetryExecutable: string | undefined;
    cacheDirectory?: string;
};

/**
 * Parses the stdout of `pet find --json` into a structured result.
 * Returns `{ managers, environments }` arrays (each may be empty).
 *
 * @param stdout Raw stdout from `pet find --json`.
 * @returns Parsed result object.
 * @throws SyntaxError if `stdout` is not valid JSON or not the expected object shape.
 */
export function parseRefreshCliOutput(stdout: string): {
    managers: NativeEnvManagerInfo[];
    environments: NativeEnvInfo[];
} {
    // May throw SyntaxError on malformed JSON — callers must handle
    const parsed = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('PET find --json output is not a JSON object');
    }
    return {
        managers: Array.isArray(parsed.managers) ? parsed.managers : [],
        environments: Array.isArray(parsed.environments) ? parsed.environments : [],
    };
}

/**
 * Parses the stdout of `pet resolve <exe> --json` into a single environment info object.
 *
 * @param stdout Raw stdout from `pet resolve --json` (trimmed).
 * @param executable The executable that was resolved (used in error messages).
 * @returns The parsed `NativeEnvInfo`.
 * @throws Error if `stdout` is `"null"` (environment not found) or malformed JSON.
 */
export function parseResolveCliOutput(stdout: string, executable: string): NativeEnvInfo {
    // May throw SyntaxError on malformed JSON — callers must handle
    const parsed: NativeEnvInfo | null = JSON.parse(stdout);
    if (parsed === null) {
        throw new Error(`PET could not identify environment for executable: ${executable}`);
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError(`PET resolve --json output is not a JSON object for ${executable}`);
    }
    return parsed;
}

/**
 * Builds the CLI arguments array for a `pet find --json` invocation.
 * This is exported for testability.
 *
 * @param config The configuration options (workspace dirs, tool paths, cache dir, env dirs).
 * @param options Optional refresh options: a kind filter string or an array of URIs to search.
 * @param venvFolders Additional virtual environment folder paths to include when searching
 *   URI-based paths (needed because searchPaths may override environmentDirectories in PET).
 * @returns The args array to pass directly to the PET binary, starting with `['find', '--json']`
 *   followed by the positional search paths and configuration flags.
 */
export function buildFindCliArgs(
    config: ConfigurationOptions,
    options?: NativePythonEnvironmentKind | Uri[],
    venvFolders: string[] = [],
): string[] {
    const args: string[] = ['find', '--json'];

    if (options) {
        if (typeof options === 'string') {
            // NativePythonEnvironmentKind — filter by environment kind.
            // In server mode, `build_refresh_config` keeps the configured workspace dirs when
            // search_kind is set, so workspace-scoped envs of that kind (e.g. Venv) are found.
            // Mirror that here by passing workspace dirs as positional search paths.
            args.push('--kind', options);
            for (const dir of config.workspaceDirectories) {
                args.push(dir);
            }
        } else if (Array.isArray(options)) {
            // Uri[] — these become the positional search paths (overriding workspace dirs).
            // In server mode, `build_refresh_config` sets search_scope = Workspace, which causes
            // find_and_report_envs to skip all global discovery phases (locators, PATH, global venvs)
            // and only search the provided paths. Mirror that with --workspace.
            //
            // Edge case: if both options and venvFolders are empty, omit --workspace entirely.
            // PET's CLI has no "search nothing" mode — with --workspace but no positional paths it
            // falls back to CWD. Falling through to the workspace-dirs path is a better approximation
            // of server-mode's empty-searchPaths behavior (which searches nothing meaningful) and
            // avoids scanning an arbitrary directory.
            const searchPaths = [...options.map((u) => u.fsPath), ...venvFolders];
            if (searchPaths.length > 0) {
                args.push('--workspace');
                for (const p of searchPaths) {
                    args.push(p);
                }
            } else {
                // No search paths at all: fall back to workspace dirs as positional args
                for (const dir of config.workspaceDirectories) {
                    args.push(dir);
                }
            }
        }
    } else {
        // No options: pass workspace directories as positional search paths
        for (const dir of config.workspaceDirectories) {
            args.push(dir);
        }
    }

    // Always forward configuration flags
    if (config.cacheDirectory) {
        args.push('--cache-directory', config.cacheDirectory);
    }
    if (config.condaExecutable) {
        args.push('--conda-executable', config.condaExecutable);
    }
    if (config.pipenvExecutable) {
        args.push('--pipenv-executable', config.pipenvExecutable);
    }
    if (config.poetryExecutable) {
        args.push('--poetry-executable', config.poetryExecutable);
    }
    // Pass each environment directory as a separate flag repetition.
    // PET's --environment-directories uses value_delimiter=',' for env-var parsing, but
    // repeating the flag on the CLI is the safe way to handle paths that contain commas.
    for (const dir of config.environmentDirectories) {
        args.push('--environment-directories', dir);
    }

    return args;
}
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
 * Cross-platform check for absolute paths.
 * Uses both current platform's check and Windows-specific check to handle
 * Windows paths (e.g., C:\path) when running on Unix systems.
 */
function isAbsolutePath(inputPath: string): boolean {
    return path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath);
}

/**
 * Gets all extra environment search paths from various configuration sources.
 * Combines legacy python settings (with migration), globalSearchPaths, and workspaceSearchPaths.
 *
 * Paths can include glob patterns which are expanded by the native
 * Python Environment Tool (PET) during environment discovery.
 *
 * @returns Array of search paths (may include glob patterns)
 */
export async function getAllExtraSearchPaths(): Promise<string[]> {
    const searchDirectories: string[] = [];

    // add legacy custom venv directories
    const customVenvDirs = getCustomVirtualEnvDirsLegacy();
    searchDirectories.push(...customVenvDirs);

    // Get globalSearchPaths
    const globalSearchPaths = getGlobalSearchPaths().filter((path) => path && path.trim() !== '');
    searchDirectories.push(...globalSearchPaths);

    // Get workspaceSearchPaths — scoped per workspace folder in multi-root workspaces
    const workspaceFolders = getWorkspaceFolders();
    const workspaceSearchPathsPerFolder: { paths: string[]; folder?: Uri }[] = [];

    if (workspaceFolders && workspaceFolders.length > 0) {
        for (const folder of workspaceFolders) {
            const paths = getWorkspaceSearchPaths(folder.uri);
            workspaceSearchPathsPerFolder.push({ paths, folder: folder.uri });
        }
    } else {
        // No workspace folders — fall back to unscoped call
        workspaceSearchPathsPerFolder.push({ paths: getWorkspaceSearchPaths() });
    }

    // Resolve relative paths against the specific folder they came from
    for (const { paths, folder } of workspaceSearchPathsPerFolder) {
        for (const searchPath of paths) {
            if (!searchPath || searchPath.trim() === '') {
                continue;
            }

            const trimmedPath = searchPath.trim();

            if (isAbsolutePath(trimmedPath)) {
                // Absolute path - use as is
                searchDirectories.push(trimmedPath);
            } else if (folder) {
                // Relative path - resolve against the specific folder it came from
                const resolvedPath = path.resolve(folder.fsPath, trimmedPath);
                searchDirectories.push(resolvedPath);
            } else {
                traceWarn('No workspace folder for relative search path:', trimmedPath);
            }
        }
    }

    // Remove duplicates and normalize to forward slashes for cross-platform glob compatibility
    const uniquePaths = Array.from(new Set(searchDirectories));
    const normalizedPaths = uniquePaths.map((p) => p.replace(/\\/g, '/'));
    traceVerbose('Environment search directories:', normalizedPaths.length, 'paths');
    return normalizedPaths;
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

let workspaceSearchPathsGlobalWarningShown = false;

/**
 * @internal Test-only helper to reset the workspaceSearchPaths global-level warning flag.
 */
export function resetWorkspaceSearchPathsGlobalWarningFlag(): void {
    workspaceSearchPathsGlobalWarningShown = false;
}

/**
 * Gets the most specific workspace-level setting available for workspaceSearchPaths.
 * Supports glob patterns which are expanded by PET.
 */
function getWorkspaceSearchPaths(scope?: Uri): string[] {
    try {
        const envConfig = getConfiguration('python-envs', scope);
        const inspection = envConfig.inspect<string[]>('workspaceSearchPaths');

        if (inspection?.globalValue && !workspaceSearchPathsGlobalWarningShown) {
            workspaceSearchPathsGlobalWarningShown = true;
            traceError(
                'python-envs.workspaceSearchPaths is set at the user/global level, but this setting can only be set at the workspace or workspace folder level.',
            );
        }

        // For workspace settings, prefer workspaceFolder > workspace > default
        if (inspection?.workspaceFolderValue) {
            return inspection.workspaceFolderValue;
        }

        if (inspection?.workspaceValue) {
            return inspection.workspaceValue;
        }

        // Use the default value from package.json
        return inspection?.defaultValue ?? [];
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
