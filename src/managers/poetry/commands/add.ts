import { CommandConstructorOptions, InstallCommand } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

/**
 * Ephemeral arguments for poetry add command (change per execution).
 */
interface AddEphemeralArgs {
    packages: { packageName: string; version?: string }[];
    upgrade?: boolean;
}

/**
 * Poetry add command.
 *
 * Parsed Command: `poetry add [--allow-prereleases] <package> [<package> ...]`
 *
 * Official Documentation: https://python-poetry.org/docs/cli/#add
 * The `poetry add` command adds required packages to your pyproject.toml and installs them.
 * It's the primary way to add dependencies to a Poetry project.
 */
export class PoetryAddCommand extends InstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: AddEphemeralArgs): string[] {
        const args = ['add'];

        if (ephemeralArgs.upgrade) {
            args.push('--allow-prereleases');
        }

        args.push(
            ...ephemeralArgs.packages.map((pkg) => {
                if (pkg.version) {
                    return `${pkg.packageName}@${pkg.version}`;
                }
                return pkg.packageName;
            }),
        );

        return args;
    }

    async execute(packages: { packageName: string; version?: string }[], upgrade?: boolean): Promise<void> {
        const args = this.buildCommand({ packages, upgrade });
        await runPoetry(args, undefined, this.log, this.cancellationToken);
    }
}
