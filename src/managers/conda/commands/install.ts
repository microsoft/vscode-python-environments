import { CommandConstructorOptions, InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda install command execute arguments (includes the target environment path).
 */
export interface CondaInstallExecuteArgs extends InstallExecuteArgs {
    environmentPath: string;
}

/**
 * Conda install command.
 *
 * Parsed Command: `conda install -y -p <environment_path> -c conda-forge [--upgrade] <package>`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands/install.html
 * The `conda install` command installs packages in the specified conda environment.
 * The `-y` flag automatically confirms the installation without prompting.
 * The `-p` flag targets a specific environment by prefix path.
 * The `-c conda-forge` flag specifies the conda-forge channel as the default package source.
 * The `--upgrade` flag updates packages to their newest versions.
 */
export class CondaInstallCommand extends InstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        const args = ['install', '-y'];

        const { environmentPath } = executeArgs as CondaInstallExecuteArgs;
        if (environmentPath) {
            args.push('-p', environmentPath);
        }

        args.push('-c', 'conda-forge');

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
