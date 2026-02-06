import {
    LogOutputChannel,
    ProgressLocation,
    QuickPickItem,
    ShellExecution,
    Task,
    TaskPanelKind,
    TaskRevealKind,
    TaskScope,
} from 'vscode';
import { spawnProcess } from '../../common/childProcess.apis';
import { UvInstallStrings } from '../../common/localize';
import { traceError, traceInfo, traceLog } from '../../common/logging';
import { getGlobalPersistentState } from '../../common/persistentState';
import { executeTask, onDidEndTaskProcess } from '../../common/tasks.apis';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred } from '../../common/utils/deferred';
import { isWindows } from '../../common/utils/platformUtils';
import { showErrorMessage, showInformationMessage, showQuickPick, withProgress } from '../../common/window.apis';
import { isUvInstalled, resetUvInstallationCache } from './helpers';

const UV_INSTALL_PYTHON_DONT_ASK_KEY = 'python-envs:uv:UV_INSTALL_PYTHON_DONT_ASK';

/**
 * Represents a Python version from uv python list
 */
export interface UvPythonVersion {
    key: string;
    version: string;
    version_parts: {
        major: number;
        minor: number;
        patch: number;
    };
    path: string | null;
    url: string | null;
    os: string;
    variant: string;
    implementation: string;
    arch: string;
}

/**
 * Checks if a command is available on the system.
 */
async function isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawnProcess(command, ['--version']);
        proc.on('error', () => resolve(false));
        proc.on('exit', (code) => resolve(code === 0));
    });
}

/**
 * Returns the platform-specific command to install uv.
 * On Unix, prefers curl but falls back to wget if curl is not available.
 */
async function getUvInstallCommand(): Promise<{ executable: string; args: string[] }> {
    if (isWindows()) {
        return {
            executable: 'powershell',
            args: ['-ExecutionPolicy', 'Bypass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex'],
        };
    }

    // macOS and Linux: try curl first, then wget
    if (await isCommandAvailable('curl')) {
        traceInfo('Using curl to install uv');
        return {
            executable: 'sh',
            args: ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
        };
    }

    if (await isCommandAvailable('wget')) {
        traceInfo('curl not found, using wget to install uv');
        return {
            executable: 'sh',
            args: ['-c', 'wget -qO- https://astral.sh/uv/install.sh | sh'],
        };
    }

    // Default to curl and let it fail with a clear error if neither is available
    traceError('Neither curl nor wget found, attempting curl anyway');
    return {
        executable: 'sh',
        args: ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
    };
}

// Timeout for task completion (5 minutes)
const TASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs a shell command as a visible VS Code task and waits for completion.
 * @param name Task name displayed in the UI
 * @param executable The command to run
 * @param args Arguments for the command
 * @returns Promise that resolves to true if the task completed successfully
 */
async function runTaskAndWait(name: string, executable: string, args: string[]): Promise<boolean> {
    const task = new Task({ type: 'shell' }, TaskScope.Global, name, 'Python', new ShellExecution(executable, args));

    task.presentationOptions = {
        reveal: TaskRevealKind.Always,
        echo: true,
        panel: TaskPanelKind.Shared,
        close: false,
        showReuseMessage: false,
    };

    const deferred = createDeferred<boolean>();

    const disposable = onDidEndTaskProcess((e) => {
        if (e.execution.task === task) {
            deferred.resolve(e.exitCode === 0);
        }
    });

    // Set up timeout to prevent indefinite waiting
    const timeoutId = setTimeout(() => {
        if (!deferred.completed) {
            traceError(`Task "${name}" timed out after ${TASK_TIMEOUT_MS / 1000} seconds`);
            deferred.resolve(false);
        }
    }, TASK_TIMEOUT_MS);

    try {
        await executeTask(task);
        return await deferred.promise;
    } catch (err) {
        traceError(`Task "${name}" failed:`, err);
        return false;
    } finally {
        clearTimeout(timeoutId);
        disposable.dispose();
    }
}

/**
 * Installs uv using the platform-appropriate method.
 * @param log Optional log output channel
 * @returns Promise that resolves to true if uv was installed successfully
 */
export async function installUv(_log?: LogOutputChannel): Promise<boolean> {
    const { executable, args } = await getUvInstallCommand();
    traceInfo(`Installing uv: ${executable} ${args.join(' ')}`);

    const success = await runTaskAndWait(UvInstallStrings.installingUv, executable, args);

    if (success) {
        // Reset the cache so isUvInstalled() will re-check
        resetUvInstallationCache();
        traceInfo('uv installed successfully');
    } else {
        traceError('Failed to install uv');
    }

    return success;
}

/**
 * Gets the path to the uv-managed Python installation.
 * Uses `uv python list --only-installed --managed-python` to find only uv-installed Pythons.
 * @param version Optional Python version to find (e.g., "3.12"). If not specified, returns the latest.
 * @returns Promise that resolves to the Python path, or undefined if not found
 */
export async function getUvPythonPath(version?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const chunks: string[] = [];
        // Use --only-installed --managed-python to find only uv-managed Pythons
        const args = ['python', 'list', '--only-installed', '--managed-python', '--output-format', 'json'];
        const proc = spawnProcess('uv', args);
        proc.stdout?.on('data', (data) => chunks.push(data.toString()));
        proc.on('error', () => resolve(undefined));
        proc.on('exit', (code) => {
            if (code === 0 && chunks.length > 0) {
                try {
                    const versions = JSON.parse(chunks.join('')) as UvPythonVersion[];
                    if (versions.length === 0) {
                        resolve(undefined);
                        return;
                    }

                    // If version specified, find matching one (e.g., "3.12" matches "3.12.11")
                    if (version) {
                        const match = versions.find((v) => v.version.startsWith(version) && v.path);
                        resolve(match?.path ?? undefined);
                    } else {
                        // Return the first (latest) installed Python
                        const installed = versions.find((v) => v.path);
                        resolve(installed?.path ?? undefined);
                    }
                } catch {
                    traceError('Failed to parse uv python list output');
                    resolve(undefined);
                }
            } else {
                resolve(undefined);
            }
        });
    });
}

/**
 * Gets available Python versions from uv.
 * @returns Promise that resolves to an array of Python versions
 */
export async function getAvailablePythonVersions(): Promise<UvPythonVersion[]> {
    return new Promise((resolve) => {
        const chunks: string[] = [];
        const proc = spawnProcess('uv', ['python', 'list', '--output-format', 'json']);
        proc.stdout?.on('data', (data) => chunks.push(data.toString()));
        proc.on('error', () => resolve([]));
        proc.on('exit', (code) => {
            if (code === 0 && chunks.length > 0) {
                try {
                    const versions = JSON.parse(chunks.join('')) as UvPythonVersion[];
                    resolve(versions);
                } catch {
                    traceError('Failed to parse uv python list output');
                    resolve([]);
                }
            } else {
                resolve([]);
            }
        });
    });
}

interface PythonVersionQuickPickItem extends QuickPickItem {
    version: string;
    isInstalled: boolean;
}

/**
 * Shows a QuickPick to select a Python version to install.
 * @returns Promise that resolves to the selected version string, or undefined if cancelled
 */
export async function selectPythonVersionToInstall(): Promise<string | undefined> {
    const versions = await withProgress(
        {
            location: ProgressLocation.Notification,
            title: UvInstallStrings.fetchingVersions,
        },
        async () => getAvailablePythonVersions(),
    );

    if (versions.length === 0) {
        showErrorMessage(UvInstallStrings.failedToFetchVersions);
        return undefined;
    }

    // Filter to only default variant (not freethreaded) and group by minor version
    const seenMinorVersions = new Set<string>();
    const items: PythonVersionQuickPickItem[] = [];

    for (const v of versions) {
        // Only include default variant CPython
        if (v.variant !== 'default' || v.implementation !== 'cpython') {
            continue;
        }

        // Create a minor version key (e.g., "3.13")
        const minorKey = `${v.version_parts.major}.${v.version_parts.minor}`;

        // Only show the latest patch for each minor version (they come sorted from uv)
        if (seenMinorVersions.has(minorKey)) {
            continue;
        }
        seenMinorVersions.add(minorKey);

        const isInstalled = v.path !== null;
        items.push({
            label: `Python ${v.version}`,
            description: isInstalled ? `$(check) ${UvInstallStrings.installed}` : undefined,
            detail: isInstalled ? (v.path ?? undefined) : undefined,
            version: v.version,
            isInstalled,
        });
    }

    const selected = await showQuickPick(items, {
        placeHolder: UvInstallStrings.selectPythonVersion,
        ignoreFocusOut: true,
    });

    if (!selected) {
        return undefined;
    }

    return selected.version;
}

/**
 * Installs Python using uv.
 * @param log Optional log output channel
 * @param version Optional Python version to install (e.g., "3.12"). If not specified, installs the latest.
 * @returns Promise that resolves to true if Python was installed successfully
 */
export async function installPythonViaUv(_log?: LogOutputChannel, version?: string): Promise<boolean> {
    const args = ['python', 'install'];
    if (version) {
        args.push(version);
    }

    traceInfo(`Installing Python via uv: uv ${args.join(' ')}`);

    const success = await runTaskAndWait(UvInstallStrings.installingPython, 'uv', args);

    if (success) {
        traceInfo('Python installed successfully via uv');
    } else {
        traceError('Failed to install Python via uv');
    }

    return success;
}

/**
 * Prompts the user to install Python via uv when no Python is found.
 * Respects the "Don't ask again" setting.
 *
 * @param trigger What triggered this prompt ('activation' or 'createEnvironment')
 * @param log Optional log output channel
 * @returns Promise that resolves to the installed Python path, or undefined if not installed
 */
export async function promptInstallPythonViaUv(
    trigger: 'activation' | 'createEnvironment',
    log?: LogOutputChannel,
): Promise<string | undefined> {
    const state = await getGlobalPersistentState();
    const dontAsk = await state.get<boolean>(UV_INSTALL_PYTHON_DONT_ASK_KEY);

    if (dontAsk) {
        traceLog('Skipping Python install prompt: user selected "Don\'t ask again"');
        return undefined;
    }

    sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_PROMPTED, undefined, { trigger });

    // Check if uv is installed to show appropriate message
    const uvInstalled = await isUvInstalled(log);
    const promptMessage = uvInstalled
        ? UvInstallStrings.installPythonPrompt
        : UvInstallStrings.installPythonAndUvPrompt;

    const result = await showInformationMessage(
        promptMessage,
        UvInstallStrings.installPython,
        UvInstallStrings.dontAskAgain,
    );

    if (result === UvInstallStrings.dontAskAgain) {
        await state.set(UV_INSTALL_PYTHON_DONT_ASK_KEY, true);
        traceLog('User selected "Don\'t ask again" for Python install prompt');
        return undefined;
    }

    if (result === UvInstallStrings.installPython) {
        return await installPythonWithUv(log);
    }

    return undefined;
}

/**
 * Installs Python using uv. If uv is not installed, installs it first.
 * This is the main entry point for programmatic Python installation.
 *
 * @param log Optional log output channel
 * @param version Optional Python version to install (e.g., "3.12")
 * @returns Promise that resolves to the installed Python path, or undefined on failure
 */
export async function installPythonWithUv(log?: LogOutputChannel, version?: string): Promise<string | undefined> {
    const uvInstalled = await isUvInstalled(log);

    sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_STARTED, undefined, { uvAlreadyInstalled: uvInstalled });

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: UvInstallStrings.installingPython,
            cancellable: false,
        },
        async () => {
            // Step 1: Install uv if not present
            if (!uvInstalled) {
                traceInfo('uv not found, installing uv first...');

                const uvSuccess = await installUv(log);
                if (!uvSuccess) {
                    sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_FAILED, undefined, { stage: 'uvInstall' });
                    showErrorMessage(UvInstallStrings.uvInstallFailed);
                    return undefined;
                }
            }

            // Step 2: Install Python via uv
            const pythonSuccess = await installPythonViaUv(log, version);
            if (!pythonSuccess) {
                sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_FAILED, undefined, { stage: 'pythonInstall' });
                showErrorMessage(UvInstallStrings.installFailed);
                return undefined;
            }

            // Step 3: Get the installed Python path using uv python find
            const pythonPath = await getUvPythonPath(version);
            if (!pythonPath) {
                traceError('Python installed but could not find the path via uv python find');
                sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_FAILED, undefined, { stage: 'findPath' });
                showErrorMessage(UvInstallStrings.installFailed);
                return undefined;
            }

            traceInfo(`Python installed successfully at: ${pythonPath}`);
            sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_COMPLETED);
            showInformationMessage(UvInstallStrings.installCompleteWithPath(pythonPath));

            return pythonPath;
        },
    );
}

/**
 * Checks if the "Don't ask again" flag is set for Python installation prompts.
 */
export async function isDontAskAgainSet(): Promise<boolean> {
    const state = await getGlobalPersistentState();
    return (await state.get<boolean>(UV_INSTALL_PYTHON_DONT_ASK_KEY)) ?? false;
}

/**
 * Clears the "Don't ask again" flag for Python installation prompts.
 */
export async function clearDontAskAgain(): Promise<void> {
    const state = await getGlobalPersistentState();
    await state.set(UV_INSTALL_PYTHON_DONT_ASK_KEY, false);
}
