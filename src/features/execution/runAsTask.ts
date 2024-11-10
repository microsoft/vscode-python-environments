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
import { PythonTaskExecutionOptions } from '../../api';
import { getWorkspaceFolder } from '../../common/workspace.apis';
import { PythonEnvironment } from '../../api';
import { executeTask } from '../../common/tasks.apis';

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

    const executable =
        environment.execInfo?.activatedRun?.executable ?? environment.execInfo?.run.executable ?? 'python';
    const args = environment.execInfo?.activatedRun?.args ?? environment.execInfo?.run.args ?? [];
    const allArgs = [...args, ...options.args];

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
