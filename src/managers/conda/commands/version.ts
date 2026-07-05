import { CommandConstructorOptions, VersionCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Conda version command.
 *
 * Parsed Command: `conda --version`
 *
 * Official Documentation: https://conda.io/projects/conda/en/latest/commands.html
 * The `conda --version` command displays the current version of conda.
 * Output format: "conda X.Y.Z" where X.Y.Z is the semantic version.
 */
export class CondaVersionCommand extends VersionCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<string> {
        const args = this.buildCommand();
        const output = await runCondaExecutable(args, this.log, executeArgs?.cancellationToken);

        // "conda X.Y.Z"
        const match = output.match(/conda\s+(\d+\.\d+(?:\.\d+)*)/i);
        return match ? match[1] : '';
    }
}
