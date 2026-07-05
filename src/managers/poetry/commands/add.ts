import { CommandConstructorOptions, InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

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

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        const args = ['add'];

        if (executeArgs.upgrade) {
            args.push('--allow-prereleases');
        }

        args.push(
            ...executeArgs.packages.map((pkg) => {
                if (pkg.version) {
                    return `${pkg.packageName}@${pkg.version}`;
                }
                return pkg.packageName;
            }),
        );

        return args;
    }

    async execute(executeArgs: InstallExecuteArgs): Promise<void> {
        const args = this.buildCommand(executeArgs);
        await runPoetry(args, undefined, this.log, executeArgs.cancellationToken);
    }
}
