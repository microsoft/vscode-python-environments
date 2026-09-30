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

        const parsed: unknown = JSON.parse(output);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !(executeArgs.packageName in parsed)
        ) {
            throw new Error(`Conda returned unexpected package version data for: ${executeArgs.packageName}`);
        }

        const entries = (parsed as Record<string, unknown>)[executeArgs.packageName];
        if (!Array.isArray(entries)) {
            throw new Error(`Conda returned unexpected package version data for: ${executeArgs.packageName}`);
        }
        const versions = entries.map((entry) => {
            if (
                typeof entry !== 'object' ||
                entry === null ||
                !('version' in entry) ||
                typeof entry.version !== 'string'
            ) {
                throw new Error(`Conda returned an invalid package version entry for: ${executeArgs.packageName}`);
            }
            return entry.version.trim();
        });
        return this.parseVersions(versions, executeArgs.includePrerelease);
    }
}
