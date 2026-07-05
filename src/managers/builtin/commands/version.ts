import { CommandConstructorOptions, VersionCommand } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Pip version command.
 *
 * Parsed Command: `python -m pip --version`
 *
 * Official Documentation: https://pip.pypa.io/en/stable/cli/pip/
 * The `pip --version` command displays the current version of pip.
 * Output format: "pip X.Y.Z from /path/to/pip (python X.Y)"
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
 * UV version command.
 *
 * Parsed Command: `uv --version`
 *
 * Official Documentation: https://docs.astral.sh/uv/
 * The `uv --version` command displays the current version of UV.
 * Output format: "uv X.Y.Z"
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
