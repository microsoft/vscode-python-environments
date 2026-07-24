import { CommandConstructorOptions, UninstallCommand, type UninstallExecuteArgs } from '../../base/commands/index';
import { runPoetry } from '../poetryUtils';

/**
 * Poetry remove command.
 *
 * Parsed Command: `poetry remove <package> [<package> ...]`
 *
 * Official Documentation: https://python-poetry.org/docs/cli/#remove
 * The `poetry remove` command removes packages from your pyproject.toml and uninstalls them
 * from your virtual environment. It removes both the dependency declaration and the installed package.
 */
export class PoetryRemoveCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        return ['remove', ...executeArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
        const args = this.buildCommand(executeArgs);
        await runPoetry(args, undefined, this.log, executeArgs.cancellationToken);
    }
}
