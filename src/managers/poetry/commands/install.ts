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
 * Concrete poetry install command (using `poetry add`).
 * Builds poetry-specific add arguments and executes via runPython.
 */
export class PoetryInstallCommand extends InstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        let args = ['add'];

        if (ephemeralArgs.upgrade) {
            args.push('--update');
        }

        args.push(...ephemeralArgs.packages.map((pkg) => {
            if (pkg.version) {
                return `${pkg.packageName}@${pkg.version}`;
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
