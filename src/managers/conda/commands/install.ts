import { runPython } from '../helpers';
import { CommandConstructorOptions, InstallCommand } from '../../base/commands/index';

/**
 * Ephemeral arguments for install command (change per execution).
 */
interface InstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
    upgrade?: boolean;
}

/**
 * Concrete conda install command.
 * Builds conda-specific install arguments and executes via runPython.
 */
export class CondaInstallCommand extends InstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        let args = ['install', '-y', '-c', 'conda-forge'];

        if (ephemeralArgs.upgrade) {
            args.push('--upgrade');
        }

        args.push(...ephemeralArgs.packages.map((pkg) => {
            if (pkg.version) {
                return `${pkg.packageName}=${pkg.version}`;
            }
            return pkg.packageName;
        }));

        return args;
    }

    async execute(
        packages: { packageName: string; version?: string }[],
        upgrade?: boolean,
    ): Promise<void> {
        const args = this.buildCommand({ packages, upgrade });

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
