import * as stackTrace from 'stack-trace';
import { commands, LogOutputChannel, window } from 'vscode';
import { Common } from '../localize';

export function parseStack(ex: Error) {
    if (ex.stack && Array.isArray(ex.stack)) {
        const concatenated = { ...ex, stack: ex.stack.join('\n') };
        return stackTrace.parse.call(stackTrace, concatenated);
    }
    return stackTrace.parse.call(stackTrace, ex);
}

export async function showErrorMessage(message: string, log?: LogOutputChannel) {
    const result = await window.showErrorMessage(message, Common.viewLogs);
    if (result === Common.viewLogs) {
        if (log) {
            log.show();
        } else {
            commands.executeCommand('python-envs.viewLogs');
        }
    }
}

export async function showWarningMessage(message: string, log?: LogOutputChannel) {
    const result = await window.showWarningMessage(message, Common.viewLogs);
    if (result === Common.viewLogs) {
        if (log) {
            log.show();
        } else {
            commands.executeCommand('python-envs.viewLogs');
        }
    }
}
