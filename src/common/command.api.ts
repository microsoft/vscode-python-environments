/* eslint-disable @typescript-eslint/no-explicit-any */
import { commands } from 'vscode';

export function executeCommand<T = unknown>(command: string, ...rest: any[]): Thenable<T> {
    return commands.executeCommand(command, ...rest);
}
