import { runPython } from '../helpers';
import { CommandConstructorOptions, UninstallCommand } from '../../base/commands/index';

/**
 * Ephemeral arguments for uninstall command (change per execution).
 */
interface UninstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Concrete poetry uninstall command (using `poetry remove`).
 * Builds poetry-specific remove arguments and executes via runPython.
 */
export class PoetryUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(ephemeralArgs: UninstallEphemeralArgs): string[] {
        return ['remove', ...ephemeralArgs.packages.map((pkg) => pkg.packageName)];
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
