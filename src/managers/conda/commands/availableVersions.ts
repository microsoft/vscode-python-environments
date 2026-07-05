import { AvailableVersionsCommand, CommandConstructorOptions } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Ephemeral arguments for conda availableVersions command (change per execution).
 */
interface AvailableVersionsEphemeralArgs {
    packageName: string;
}

/**
 * Conda available versions command.
 *
 * Parsed Command: `conda search <package> --json`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands/search.html
 * The `conda search` command searches for packages in the conda channels.
 * The `--json` flag outputs results in JSON format for structured parsing.
 * Returns all builds of all versions available; deduplication is performed in the command.
 * NOTE: The pythonVersion parameter is ignored for conda (unlike pip) as conda doesn't filter by Python version.
 */
export class CondaAvailableVersionsCommand extends AvailableVersionsCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[] {
        return ['search', ephemeralArgs.packageName, '--json'];
    }

    async execute(packageName: string, _pythonVersion: string, _includePrerelease?: boolean): Promise<string[]> {
        const args = this.buildCommand({ packageName });
        const output = await runCondaExecutable(args, this.log, this.cancellationToken);

        try {
            const parsed = JSON.parse(output);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed[packageName])) {
                const uniqueVersions = new Map<string, string>();
                (parsed[packageName] as Array<{ version?: string }>)
                    .filter((entry) => !!entry.version?.trim())
                    .forEach((entry) => {
                        const version = entry.version!.trim();
                        if (!uniqueVersions.has(version)) {
                            uniqueVersions.set(version, version);
                        }
                    });

                return Array.from(uniqueVersions.values());
            }
            return [];
        } catch {
            return [];
        }
    }
}
