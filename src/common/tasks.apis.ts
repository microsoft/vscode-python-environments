import { Disposable, Task, TaskExecution, TaskProcessEndEvent, tasks } from 'vscode';

export async function executeTask(task: Task): Promise<TaskExecution> {
    return tasks.executeTask(task);
}

export function onDidEndTaskProcess(
    listener: (e: TaskProcessEndEvent) => unknown,
    thisArgs?: unknown,
    disposables?: Disposable[],
): Disposable {
    return tasks.onDidEndTaskProcess(listener, thisArgs, disposables);
}
