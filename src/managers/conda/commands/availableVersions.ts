import type { Pep440Version } from '@renovatebot/pep440';
import { AvailableVersionsCommand, type AvailableVersionsExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda available versions command.
 * Parsed command: `conda search <package> --json`
 * Official documentation: https://docs.conda.io/projects/conda/en/latest/commands/search.html
 */
export class CondaAvailableVersionsCommand extends AvailableVersionsCommand {
    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        return ['search', executeArgs.packageName, '--json'];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<Pep440Version[]> {
        const output = await runCondaExecutable(
            this.buildCommand(executeArgs),
            this.log,
            executeArgs.cancellationToken,
        );

        try {
            const parsed = JSON.parse(output);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed[executeArgs.packageName])) {
                const versions = (parsed[executeArgs.packageName] as Array<{ version?: string }>)
                    .map((entry) => entry.version?.trim() ?? '')
                    .filter((version) => !!version);
                return this.parseVersions(versions, executeArgs.includePrerelease);
            }
            return [];
        } catch {
            return [];
        }
    }
}
