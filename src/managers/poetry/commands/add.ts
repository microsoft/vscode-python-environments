import { InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runPoetry } from './runPoetry';

/**
 * Poetry add command.
 * Parsed command: `poetry add <package> [<package> ...]`
 * Official documentation: https://python-poetry.org/docs/cli/#add
 */
export class PoetryAddCommand extends InstallCommand {
    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        const args = ['add'];
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
        await runPoetry(this.buildCommand(executeArgs), this.cwd, this.log, executeArgs.cancellationToken);
    }
}
