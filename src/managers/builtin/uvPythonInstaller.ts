import {
    LogOutputChannel,
    ProgressLocation,
    ShellExecution,
    Task,
    TaskPanelKind,
    TaskRevealKind,
    TaskScope,
    tasks,
    window,
} from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { spawnProcess } from '../../common/childProcess.apis';
import { UvInstallStrings } from '../../common/localize';
import { traceError, traceInfo, traceLog } from '../../common/logging';
import { getGlobalPersistentState } from '../../common/persistentState';
import { executeTask } from '../../common/tasks.apis';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred } from '../../common/utils/deferred';
import { isWindows } from '../../common/utils/platformUtils';
import { showInformationMessage } from '../../common/window.apis';
import { isUvInstalled, resetUvInstallationCache } from './helpers';

const UV_INSTALL_PYTHON_DONT_ASK_KEY = 'python-envs:uv:UV_INSTALL_PYTHON_DONT_ASK';

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

    const disposable = tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task === task) {
            disposable.dispose();
            deferred.resolve(e.exitCode === 0);
        }
    });

    try {
        await executeTask(task);
        return await deferred.promise;
    } catch (err) {
        disposable.dispose();
        traceError(`Task "${name}" failed:`, err);
        return false;
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
 * @param api The Python environment API (used to refresh environments after installation)
 * @param log Optional log output channel
 * @returns Promise that resolves to true if Python was successfully installed
 */
export async function promptInstallPythonViaUv(
    trigger: 'activation' | 'createEnvironment',
    api: PythonEnvironmentApi,
    log?: LogOutputChannel,
): Promise<boolean> {
    const state = await getGlobalPersistentState();
    const dontAsk = await state.get<boolean>(UV_INSTALL_PYTHON_DONT_ASK_KEY);

    if (dontAsk) {
        traceLog('Skipping Python install prompt: user selected "Don\'t ask again"');
        return false;
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
        return false;
    }

    if (result === UvInstallStrings.installPython) {
        return await installPythonWithUv(api, log);
    }

    return false;
}

/**
 * Installs Python using uv. If uv is not installed, installs it first.
 * This is the main entry point for programmatic Python installation.
 *
 * @param api The Python environment API (used to refresh environments after installation)
 * @param log Optional log output channel
 * @returns Promise that resolves to true if Python was successfully installed
 */
export async function installPythonWithUv(api: PythonEnvironmentApi, log?: LogOutputChannel): Promise<boolean> {
    const uvInstalled = await isUvInstalled(log);

    sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_STARTED, undefined, { uvAlreadyInstalled: uvInstalled });

    return await window.withProgress(
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
                    window.showErrorMessage(UvInstallStrings.uvInstallFailed);
                    return false;
                }
            }

            // Step 2: Install Python via uv
            const pythonSuccess = await installPythonViaUv(log);
            if (!pythonSuccess) {
                sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_FAILED, undefined, { stage: 'pythonInstall' });
                window.showErrorMessage(UvInstallStrings.installFailed);
                return false;
            }

            // Step 3: Refresh environments to detect newly installed Python
            traceInfo('Refreshing environments after Python installation...');
            await api.refreshEnvironments(undefined);

            sendTelemetryEvent(EventNames.UV_PYTHON_INSTALL_COMPLETED);
            window.showInformationMessage(UvInstallStrings.installComplete);

            return true;
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
