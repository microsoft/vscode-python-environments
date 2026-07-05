import { CommandConstructorOptions, UninstallCommand } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

/**
 * Ephemeral arguments for poetry remove command (change per execution).
 */
interface RemoveEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Concrete poetry remove command.
 * Builds poetry-specific remove arguments and executes via runPoetry.
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
