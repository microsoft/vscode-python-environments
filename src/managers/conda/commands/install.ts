import { CommandConstructorOptions, InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda install command.
 *
 * Parsed Command: `conda install -y -c conda-forge [--upgrade] <package>`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands/install.html
 * The `conda install` command installs packages in the current conda environment.
 * The `-y` flag automatically confirms the installation without prompting.
 * The `-c conda-forge` flag specifies the conda-forge channel as the default package source.
 * The `--upgrade` flag updates packages to their newest versions.
 */
export class CondaInstallCommand extends InstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        let args = ['install', '-y', '-c', 'conda-forge'];

        if (executeArgs.upgrade) {
            args.push('--upgrade');
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
        const args = this.buildCommand(executeArgs);

        await runCondaExecutable(args, this.log, executeArgs.cancellationToken);
    }
}
