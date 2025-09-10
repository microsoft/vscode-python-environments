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
        // Get custom virtual environment directories
        const customVenvDirs = getCustomVirtualEnvDirs();
        
        // Get final search set from searchPaths setting
        const finalSearchSet = await createFinalSearchSet();
        
        // Combine and deduplicate all environment directories
        const allEnvironmentDirectories = [...customVenvDirs, ...finalSearchSet];
        const environmentDirectories = Array.from(new Set(allEnvironmentDirectories));
        
        traceLog('Custom venv directories:', customVenvDirs);
        traceLog('Final search set:', finalSearchSet);
        traceLog('Combined environment directories:', environmentDirectories);

        const options: ConfigurationOptions = {
            workspaceDirectories: this.api.getPythonProjects().map((item) => item.uri.fsPath),
            // Include both custom venv dirs and search paths
            environmentDirectories,
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

function getPythonEnvSettingAndUntildify<T>(name: string, scope?: Uri): T | undefined {
    const value = getConfiguration('python-env', scope).get<T>(name);
    if (typeof value === 'string') {
        return value ? (untildify(value as string) as unknown as T) : undefined;
    }
    return value;
}

/**
 * Creates the final search set from configured search paths.
 * Handles executables, directories, and regex patterns.
 */
async function createFinalSearchSet(): Promise<string[]> {
    const searchPaths = getPythonEnvSettingAndUntildify<string[]>('searchPaths') ?? [];
    const finalSearchSet: string[] = [];

    traceLog('Processing search paths:', searchPaths);

    for (const searchPath of searchPaths) {
        try {
            if (!searchPath || searchPath.trim() === '') {
                continue;
            }

            const trimmedPath = searchPath.trim();
            
            // Check if it's a regex pattern (contains regex special characters)
            // Note: Windows paths contain backslashes, so we need to be more careful
            const regexChars = /[*?[\]{}()^$+|]/;
            const hasBackslash = trimmedPath.includes('\\');
            const isWindowsPath = hasBackslash && (trimmedPath.match(/^[A-Za-z]:\\/) || trimmedPath.match(/^\\\\[^\\]+\\/));
            const isRegexPattern = regexChars.test(trimmedPath) || (hasBackslash && !isWindowsPath);
            
            if (isRegexPattern) {
                traceLog('Processing regex pattern:', trimmedPath);
                traceLog('Warning: Using regex patterns in searchPaths may cause performance issues');
                
                // Use workspace.findFiles to search for python executables
                const foundFiles = await workspace.findFiles(trimmedPath, null);
                
                for (const file of foundFiles) {
                    const filePath = file.fsPath;
                    // Check if it's likely a python executable
                    if (filePath.toLowerCase().includes('python') || path.basename(filePath).startsWith('python')) {
                        // Get grand-grand parent folder (file -> bin -> env -> this)
                        const grandGrandParent = path.dirname(path.dirname(path.dirname(filePath)));
                        if (grandGrandParent && grandGrandParent !== path.dirname(grandGrandParent)) {
                            finalSearchSet.push(grandGrandParent);
                            traceLog('Added grand-grand parent from regex match:', grandGrandParent);
                        }
                    }
                }
            } 
            // Check if it's a direct executable path
            else if (await fs.pathExists(trimmedPath) && (await fs.stat(trimmedPath)).isFile()) {
                traceLog('Processing executable path:', trimmedPath);
                // Get grand-grand parent folder
                const grandGrandParent = path.dirname(path.dirname(path.dirname(trimmedPath)));
                if (grandGrandParent && grandGrandParent !== path.dirname(grandGrandParent)) {
                    finalSearchSet.push(grandGrandParent);
                    traceLog('Added grand-grand parent from executable:', grandGrandParent);
                }
            }
            // Check if it's a directory path
            else if (await fs.pathExists(trimmedPath) && (await fs.stat(trimmedPath)).isDirectory()) {
                traceLog('Processing directory path:', trimmedPath);
                // Add directory as-is
                finalSearchSet.push(trimmedPath);
                traceLog('Added directory as-is:', trimmedPath);
            }
            // If path doesn't exist, try to check if it could be an executable that might exist later
            else {
                traceLog('Path does not exist, treating as potential directory:', trimmedPath);
                // Treat as directory path for future resolution
                finalSearchSet.push(trimmedPath);
            }
        } catch (error) {
            traceLog('Error processing search path:', searchPath, error);
        }
    }

    // Remove duplicates and return
    const uniquePaths = Array.from(new Set(finalSearchSet));
    traceLog('Final search set created:', uniquePaths);
    return uniquePaths;
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
