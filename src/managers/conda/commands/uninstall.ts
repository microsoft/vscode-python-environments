import { CommandConstructorOptions, UninstallCommand } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Ephemeral arguments for uninstall command (change per execution).
 */
interface UninstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Concrete conda uninstall command.
 * Builds conda-specific uninstall arguments and executes via runConda.
 */
export class CondaUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: UninstallEphemeralArgs): string[] {
        return ['remove', '-y', ...ephemeralArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(packages: { packageName: string; version?: string }[]): Promise<void> {
        const args = this.buildCommand({ packages });

        await runCondaExecutable(args, this.log, this.cancellationToken);
    }
}
