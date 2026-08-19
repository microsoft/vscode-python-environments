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
        let parsed: unknown;
        try {
            parsed = JSON.parse(output);
        } catch (error) {
            this.log?.error('Failed to parse conda list output', error);
            throw error;
        }
        if (!Array.isArray(parsed)) {
            const error = new Error('Invalid conda list output: expected a JSON array');
            this.log?.error(error.message);
            throw error;
        }

        const packages: PackageInfo[] = [];
        for (const condaPkg of parsed) {
            if (
                typeof condaPkg === 'object' &&
                condaPkg !== null &&
                typeof condaPkg.name === 'string' &&
                typeof condaPkg.version === 'string'
            ) {
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
