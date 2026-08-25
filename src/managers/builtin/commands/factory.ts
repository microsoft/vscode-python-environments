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
    return (await shouldUseUv(options.log, environmentPath))
        ? { kind: 'uv', command: new UvCommand(options) }
        : { kind: 'pip', command: new PipCommand(options) };
}

export async function createPipOrUvCommand<T, P extends T, U extends T>(
    options: CommandConstructorOptions,
    environmentPath: string,
    PipCommand: CommandConstructor<P>,
    UvCommand: CommandConstructor<U>,
): Promise<T> {
    return (await createPipOrUvCommandWithKind(options, environmentPath, PipCommand, UvCommand)).command;
}
