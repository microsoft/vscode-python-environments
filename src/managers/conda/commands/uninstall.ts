import { CommandConstructorOptions, UninstallCommand, type UninstallEphemeralArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda uninstall command.
 *
 * Parsed Command: `conda remove -y <package>`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands/remove.html
 * The `conda remove` command (alias `conda uninstall`) removes packages from the current environment.
 * The `-y` flag automatically confirms the removal without prompting.
 * Removes both the package and its unused dependencies by default.
 */
export class CondaUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: UninstallEphemeralArgs): string[] {
        return ['remove', '-y', ...ephemeralArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(ephemeralArgs: UninstallEphemeralArgs): Promise<void> {
        const args = this.buildCommand(ephemeralArgs);

        await runCondaExecutable(args, this.log, this.cancellationToken);
    }
}
