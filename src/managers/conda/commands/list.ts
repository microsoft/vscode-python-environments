import { PackageInfo } from '../../../api';
import { ListCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';
import { CondaCommandConstructorOptions } from './condaCommandOptions';

/**
 * Indicates that `conda list` completed but returned malformed or unexpected output.
 */
export class CondaListOutputError extends Error {
    constructor(
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'CondaListOutputError';
    }
}

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
            throw new CondaListOutputError('Failed to parse conda list output', error);
        }
        if (!Array.isArray(parsed)) {
            throw new CondaListOutputError('Invalid conda list output: expected a JSON array');
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
