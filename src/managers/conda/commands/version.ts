import { CommandConstructorOptions, VersionCommand } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Concrete conda version command.
 * Builds conda-specific version arguments and returns version string.
 */
export class CondaVersionCommand extends VersionCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(): Promise<string> {
        const args = this.buildCommand();
        const output = await runCondaExecutable(args, this.log, this.cancellationToken);

        // "conda X.Y.Z"
        const match = output.match(/conda\s+(\d+\.\d+(?:\.\d+)*)/i);
        return match ? match[1] : '';
    }
}
