import type { Pep440Version } from '@renovatebot/pep440';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { VersionCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda version command.
 * Parsed command: `conda --version`
 * Official documentation: https://docs.conda.io/projects/conda/en/latest/commands.html
 */
export class CondaVersionCommand extends VersionCommand {
    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<Pep440Version | undefined> {
        const output = await runCondaExecutable(this.buildCommand(), this.log, executeArgs?.cancellationToken);

        // "conda X.Y.Z"
        const match = output.match(/conda\s+(\d+\.\d+(?:\.\d+)*)/i);
        return match ? (parsePep440Version(match[1]) ?? undefined) : undefined;
    }
}
