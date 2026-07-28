import { UninstallCommand, type UninstallExecuteArgs } from '../../base/commands/index';
import { runPoetry } from './runPoetry';

/**
 * Poetry remove command.
 * Parsed command: `poetry remove <package> [<package> ...]`
 * Official documentation: https://python-poetry.org/docs/cli/#remove
 */
export class PoetryRemoveCommand extends UninstallCommand {
    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        return ['remove', ...executeArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
        await runPoetry(this.buildCommand(executeArgs), undefined, this.log, executeArgs.cancellationToken);
    }
}
