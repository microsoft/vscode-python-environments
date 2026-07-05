import { PackageInfo } from '../../../api';
import { CommandConstructorOptions, ListCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda list command execute arguments (includes environment path and cancellation token).
 */
interface CondaListExecuteArgs extends BaseExecuteArgs {
    environmentPath: string;
}

/**
 * Conda list command.
 *
 * Parsed Command: `conda list -p <environment_path> --json`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands/list.html
 * The `conda list` command shows all installed packages in a conda environment.
 * The `-p` flag specifies the environment path (can be absolute or relative).
 * The `--json` flag outputs the package list in JSON format for structured parsing.
 */
export class CondaListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: BaseExecuteArgs): string[] {
        const args = executeArgs as CondaListExecuteArgs;
        return ['list', '-p', args.environmentPath, '--json'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]> {
        const args = executeArgs as CondaListExecuteArgs | undefined;
        if (!args?.environmentPath) {
            return [];
        }

        const cmdArgs = this.buildCommand(executeArgs!);
        const output = await runCondaExecutable(cmdArgs, this.log, executeArgs?.cancellationToken);

        let condaPackages: { name: string; version: string }[];
        try {
            condaPackages = JSON.parse(output) as { name: string; version: string }[];
        } catch {
            return [];
        }

        const packages: PackageInfo[] = [];
        for (const condaPkg of condaPackages) {
            if (condaPkg.name && condaPkg.version) {
                packages.push({
                    name: condaPkg.name,
                    displayName: condaPkg.name,
                    version: condaPkg.version,
                    description: condaPkg.version,
                });
            }
        }

        return packages;
    }
}
