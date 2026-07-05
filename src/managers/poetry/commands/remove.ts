import { CommandConstructorOptions, UninstallCommand } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

/**
 * Ephemeral arguments for poetry remove command (change per execution).
 */
interface RemoveEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

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

    protected buildCommand(ephemeralArgs: RemoveEphemeralArgs): string[] {
        return ['remove', ...ephemeralArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(packages: { packageName: string; version?: string }[]): Promise<void> {
        const args = this.buildCommand({ packages });
        await runPoetry(args, undefined, this.log, this.cancellationToken);
    }
}
