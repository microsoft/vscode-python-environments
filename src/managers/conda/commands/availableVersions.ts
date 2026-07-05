import {
    AvailableVersionsCommand,
    CommandConstructorOptions,
    type AvailableVersionsExecuteArgs,
} from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

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

    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        return ['search', executeArgs.packageName, '--json'];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]> {
        const args = this.buildCommand(executeArgs);
        const output = await runCondaExecutable(args, this.log, this.cancellationToken);

        try {
            const parsed = JSON.parse(output);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed[executeArgs.packageName])) {
                const uniqueVersions = new Map<string, string>();
                (parsed[executeArgs.packageName] as Array<{ version?: string }>)
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
