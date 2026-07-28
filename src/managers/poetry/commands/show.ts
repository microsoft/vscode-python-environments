import { PackageInfo } from '../../../api';
import { ListCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runPoetry } from './runPoetry';

export interface PoetryShowExecuteArgs extends BaseExecuteArgs {
    cwd?: string;
}

/**
 * Poetry show command.
 * Parsed command: `poetry show --no-ansi`
 * Official documentation: https://python-poetry.org/docs/cli/#show
 */
export class PoetryShowCommand extends ListCommand {
    protected buildCommand(): string[] {
        return ['show', '--no-ansi'];
    }

    async execute(executeArgs?: PoetryShowExecuteArgs): Promise<PackageInfo[]> {
        const output = await runPoetry(this.buildCommand(), executeArgs?.cwd, this.log, executeArgs?.cancellationToken);
        const packages: PackageInfo[] = [];
        try {
            // Parse poetry show output
            // Format: name         version    description
            const lines = output.split('\n');
            for (const line of lines) {
                // Updated regex to properly handle lines with the format:
                // "package (!) version description"
                const match = line.match(/^(\S+)(?:\s+\([!]\))?\s+(\S+)\s+(.*)/);
                if (match) {
                    const [, name, version, description] = match;
                    packages.push({
                        name,
                        displayName: name,
                        version,
                        description: `${version} - ${description?.trim() || ''}`,
                    });
                }
            }
        } catch {
            return [];
        }

        return packages;
    }
}
