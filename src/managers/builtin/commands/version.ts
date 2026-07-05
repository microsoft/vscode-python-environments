import { CommandConstructorOptions, VersionCommand } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Concrete pip version command.
 * Builds pip-specific version arguments, parses output, and returns version string.
 */
export class PipVersionCommand extends VersionCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['-m', 'pip', '--version'];
    }

    async execute(): Promise<string> {
        let versionString: string = '';

        const parser = (output: string): void => {
            // "pip X.Y.Z from /path/to/pip (python X.Y)"
            const match = output.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
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

/**
 * Concrete uv version command.
 * Builds uv-specific version arguments, parses output, and returns version string.
 */
export class UvVersionCommand extends VersionCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(): Promise<string> {
        let versionString: string = '';

        const parser = (output: string): void => {
            // "uv X.Y.Z" format
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
