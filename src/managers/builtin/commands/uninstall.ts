import { CommandConstructorOptions, UninstallCommand } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Ephemeral arguments for uninstall command (change per execution).
 */
interface UninstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Concrete pip uninstall command.
 * Builds pip-specific uninstall arguments and executes via runPython.
 */
export class PipUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(ephemeralArgs: UninstallEphemeralArgs): string[] {
        return ['-m', 'pip', 'uninstall', '-y', ...ephemeralArgs.packages.map((pkg) => pkg.packageName)];
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

/**
 * Concrete uv uninstall command.
 * Builds uv-specific uninstall arguments and executes via runPython.
 */
export class UvUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: UninstallEphemeralArgs): string[] {
        const args = ['pip', 'uninstall', '-y', '--python', this.pythonExecutable];
        args.push(...ephemeralArgs.packages.map((pkg) => pkg.packageName));
        return args;
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
