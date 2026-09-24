import { UninstallCommand, type UninstallExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';
import { CondaCommandConstructorOptions } from './condaCommandOptions';

/**
 * Conda uninstall command.
 * Parsed command: `conda remove -y -p <environment_path> <package>`
 * Official documentation: https://docs.conda.io/projects/conda/en/latest/commands/remove.html
 */
export class CondaUninstallCommand extends UninstallCommand {
    private readonly condaEnvironmentPath: string;

    constructor(options: CondaCommandConstructorOptions) {
        super(options);
        this.condaEnvironmentPath = options.condaEnvironmentPath;
    }

    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        const args = ['remove', '-y', '-p', this.condaEnvironmentPath];
        args.push(...executeArgs.packages.map((pkg) => pkg.packageName));
        return args;
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
        await runCondaExecutable(this.buildCommand(executeArgs), this.log, executeArgs.cancellationToken);
    }
}
