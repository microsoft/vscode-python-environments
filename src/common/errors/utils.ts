import * as stackTrace from 'stack-trace';
import { commands, LogOutputChannel, window } from 'vscode';

export function parseStack(ex: Error) {
    if (ex.stack && Array.isArray(ex.stack)) {
        const concatenated = { ...ex, stack: ex.stack.join('\n') };
        return stackTrace.parse.call(stackTrace, concatenated);
    }
    return stackTrace.parse.call(stackTrace, ex);
}

export async function showErrorMessage(message: string, log?: LogOutputChannel) {
    const result = await window.showErrorMessage(message, 'View Logs');
    if (result === 'View Logs') {
        if (log) {
            log.show();
        } else {
            commands.executeCommand('python-envs.viewLogs');
        }
    }
}

export async function showWarningMessage(message: string, log?: LogOutputChannel) {
    const result = await window.showWarningMessage(message, 'View Logs');
    if (result === 'View Logs') {
        if (log) {
            log.show();
        } else {
            commands.executeCommand('python-envs.viewLogs');
        }
    }
}
