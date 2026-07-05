import { PackageInfo } from '../../../api';
import { CommandConstructorOptions, ListCommand } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

/**
 * Poetry show command.
 *
 * Parsed Command: `poetry show --no-ansi`
 *
 * Official Documentation: https://python-poetry.org/docs/cli/#show
 * The `poetry show` command displays information about the installed packages.
 * The `--no-ansi` flag disables ANSI color output for easier parsing.
 */
export class PoetryShowCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['show', '--no-ansi'];
    }

    async execute(): Promise<PackageInfo[]> {
        const args = this.buildCommand();
        const output = await runPoetry(args, undefined, this.log, this.cancellationToken);

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
