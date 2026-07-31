import { InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';
import { CondaCommandConstructorOptions } from './condaCommandOptions';

/**
 * Conda install command.
 * Parsed command: `conda install --prefix <environment_path> --yes <package>`
 * Parsed command (upgrade): `conda install --prefix <environment_path> --yes --update-all <package>`
 * Official documentation: https://docs.conda.io/projects/conda/en/latest/commands/install.html
 */
export class CondaInstallCommand extends InstallCommand {
    private readonly condaEnvironmentPath: string;

    constructor(options: CondaCommandConstructorOptions) {
        super(options);
        this.condaEnvironmentPath = options.condaEnvironmentPath;
    }

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        const args = ['install', '--prefix', this.condaEnvironmentPath, '--yes'];
        if (executeArgs.upgrade) {
            args.push('--update-all');
        }
        args.push(
            ...executeArgs.packages.map((pkg) => {
                if (pkg.version) {
                    return `${pkg.packageName}=${pkg.version}`;
                }
                return pkg.packageName;
            }),
        );
        return args;
    }

    async execute(executeArgs: InstallExecuteArgs): Promise<void> {
        await runCondaExecutable(this.buildCommand(executeArgs), this.log, executeArgs.cancellationToken);
    }
}
