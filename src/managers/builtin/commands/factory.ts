import { CommandConstructorOptions } from '../../base/commands/index';
import { shouldUseUv } from '../helpers';

type CommandConstructor<T> = new (options: CommandConstructorOptions) => T;

export async function createPipOrUvCommand<T, P extends T, U extends T>(
    options: CommandConstructorOptions,
    PipCommand: CommandConstructor<P>,
    UvCommand: CommandConstructor<U>,
): Promise<T> {
    return (await shouldUseUv(options.log, options.pythonExecutable))
        ? new UvCommand(options)
        : new PipCommand(options);
}
