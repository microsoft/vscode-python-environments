import { PackageInfo } from '../../../api';
import { ListCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';
import { CondaCommandConstructorOptions } from './condaCommandOptions';

/**
 * Conda list command.
 * Parsed command: `conda list -p <environment_path> --json`
 * Official documentation: https://docs.conda.io/projects/conda/en/latest/commands/list.html
 */
export class CondaListCommand extends ListCommand {
    private readonly condaEnvironmentPath: string;

    constructor(options: CondaCommandConstructorOptions) {
        super(options);
        this.condaEnvironmentPath = options.condaEnvironmentPath;
    }

    protected buildCommand(): string[] {
        return ['list', '-p', this.condaEnvironmentPath, '--json'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]> {
        const output = await runCondaExecutable(this.buildCommand(), this.log, executeArgs?.cancellationToken);
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
