import { CommandConstructorOptions } from '../../base/commands/index';
import { shouldUseUv } from '../helpers';

type CommandConstructor<T> = new (options: CommandConstructorOptions) => T;

export type PipOrUvCommand<P, U> = { kind: 'pip'; command: P } | { kind: 'uv'; command: U };

export async function createPipOrUvCommandWithKind<P, U>(
    options: CommandConstructorOptions,
    environmentPath: string,
    PipCommand: CommandConstructor<P>,
    UvCommand: CommandConstructor<U>,
): Promise<PipOrUvCommand<P, U>> {
    if (await shouldUseUv(options.log, environmentPath)) {
        // uv accepts an environment directory as its `--python` target. A symlinked
        // environment executable (for example Pipenv) can resolve to the externally
        // managed base interpreter, so passing the environment directory preserves
        // the environment boundary. Pip commands keep using the interpreter itself.
        return { kind: 'uv', command: new UvCommand({ ...options, pythonExecutable: environmentPath }) };
    }
    return { kind: 'pip', command: new PipCommand(options) };
}

export async function createPipOrUvCommand<T, P extends T, U extends T>(
    options: CommandConstructorOptions,
    environmentPath: string,
    PipCommand: CommandConstructor<P>,
    UvCommand: CommandConstructor<U>,
): Promise<T> {
    return (await createPipOrUvCommandWithKind(options, environmentPath, PipCommand, UvCommand)).command;
}
