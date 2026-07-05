import { runPython } from '../helpers';
import { CommandConstructorOptions, VersionCommand } from '../../base/commands/index';

/**
 * Concrete poetry version command.
 * Builds poetry-specific version arguments, parses output, and returns version string.
 */
export class PoetryVersionCommand extends VersionCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(): Promise<string> {
        let versionString: string = '';

        const parser = (output: string): void => {
            // "Poetry (version X.Y.Z)" or similar
            const match = output.match(/(\d+\.\d+(?:\.\d+)*)/);
            versionString = match ? match[1] : '';
        };

        const args = this.buildCommand();

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );

        parser(output);
        return versionString;
    }
}
