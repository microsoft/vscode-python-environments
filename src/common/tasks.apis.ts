import { Disposable, Task, TaskExecution, TaskProcessStartEvent, tasks } from 'vscode';
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function executeTask(task: Task): Promise<TaskExecution> {
    return tasks.executeTask(task);
}

export function onDidStartTaskProcess(
    listener: (e: TaskProcessStartEvent) => any,
    thisArgs?: any,
    disposables?: Disposable[],
): Disposable {
    return tasks.onDidStartTaskProcess(listener, thisArgs, disposables);
}
