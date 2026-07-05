import { runPython } from '../helpers';
import { CommandConstructorOptions, UninstallCommand } from '../../base/commands/index';

/**
 * Ephemeral arguments for uninstall command (change per execution).
 */
interface UninstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Concrete conda uninstall command.
 * Builds conda-specific uninstall arguments and executes via runPython.
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

        await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );
    }
}
