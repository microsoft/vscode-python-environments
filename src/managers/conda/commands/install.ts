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
 * Parsed Command: `conda install -y -p <environment_path> <package>`
 * Parsed Command (upgrade): `conda update -y -p <environment_path> <package>`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands/install.html
 * The `conda install` command installs packages in the specified conda environment.
 * The `-y` flag automatically confirms the installation without prompting.
 * The `-p` flag targets a specific environment by prefix path.
 * Uses `conda update` when upgrade is requested.
 */
export class CondaInstallCommand extends InstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        const args = [executeArgs.upgrade ? 'update' : 'install', '-y'];

        const { environmentPath } = executeArgs as CondaInstallExecuteArgs;
        if (environmentPath) {
            args.push('-p', environmentPath);
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
