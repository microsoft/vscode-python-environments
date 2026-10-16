import { commands } from 'vscode';
import { Disposable } from 'vscode-jsonrpc';

/** Registers a command with inferred callback arguments and an optional receiver. */
export function registerCommand<TArgs extends unknown[], TResult, TThis = void>(
    command: string,
    callback: (this: TThis, ...args: TArgs) => TResult,
    thisArg?: TThis,
): Disposable {
    return commands.registerCommand(command, callback, thisArg);
}

/** Executes a command with its arguments; callers specify the expected result type. */
export function executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T> {
    return commands.executeCommand(command, ...rest);
}
