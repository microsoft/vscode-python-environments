import {
    ShellExecution,
    Task,
    TaskExecution,
    TaskPanelKind,
    TaskRevealKind,
    TaskScope,
    Uri,
    WorkspaceFolder,
} from 'vscode';
import { PythonEnvironment, PythonTaskExecutionOptions } from '../../api';
import { traceInfo, traceWarn } from '../../common/logging';
import { executeTask } from '../../common/tasks.apis';
import { getWorkspaceFolder } from '../../common/workspace.apis';
import { shouldUseUv } from '../../managers/builtin/helpers';
import { quoteStringIfNecessary } from './execUtils';
import { isPep723Script } from './pep723';

function getWorkspaceFolderOrDefault(uri?: Uri): WorkspaceFolder | TaskScope {
    const workspace = uri ? getWorkspaceFolder(uri) : undefined;
    return workspace ?? TaskScope.Global;
}

export async function runAsTask(
    environment: PythonEnvironment,
    options: PythonTaskExecutionOptions,
    extra?: { reveal?: TaskRevealKind },
): Promise<TaskExecution> {
    const workspace: WorkspaceFolder | TaskScope = getWorkspaceFolderOrDefault(options.project?.uri);

    let executable = environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable;
    if (!executable) {
        traceWarn('No Python executable found in environment; falling back to "python".');
        executable = 'python';
    }

    const envArgs = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const useUv = await shouldUseUv(undefined, environment.environmentPath.fsPath, options.project?.uri);

    let allArgs: string[];
    if (useUv) {
        // Detect whether the first user argument is a PEP 723 self-contained script.
        // A PEP 723 script declares its own Python version and dependencies inline, so
        // uv manages the environment entirely — we must NOT pin a `--python` interpreter
        // or inject env-specific args, as that would override the script's own requirements.
        const candidateScript =
            options.args.length > 0 && !options.args[0].startsWith('-') ? options.args[0] : undefined;
        const pep723 = candidateScript ? await isPep723Script(candidateScript) : false;

        if (pep723) {
            // PEP 723: `uv run <script> [userArgs]` — uv picks the interpreter itself
            traceInfo(`PEP 723 script detected: ${candidateScript}. Running with uv without --python.`);
            allArgs = ['run', ...options.args];
        } else {
            // Standard script: pin the saved interpreter via --python
            let pythonArg = executable;
            if (pythonArg.startsWith('"') && pythonArg.endsWith('"')) {
                pythonArg = pythonArg.substring(1, pythonArg.length - 1);
            }
            allArgs = ['run', '--python', pythonArg, ...envArgs, ...options.args];
        }
        executable = 'uv';
    } else {
        allArgs = [...envArgs, ...options.args];
    }

    // Check and quote the executable path if necessary
    executable = quoteStringIfNecessary(executable);
    traceInfo(`Running as task: ${executable} ${allArgs.join(' ')}`);

    const task = new Task(
        { type: 'python' },
        workspace,
        options.name,
        'Python',
        new ShellExecution(executable, allArgs, { cwd: options.cwd, env: options.env }),
        '$python',
    );

    task.presentationOptions = {
        reveal: extra?.reveal ?? TaskRevealKind.Silent,
        echo: true,
        panel: TaskPanelKind.Shared,
        close: false,
        showReuseMessage: true,
    };

    return executeTask(task);
}
