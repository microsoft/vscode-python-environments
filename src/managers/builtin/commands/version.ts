import type { Pep440Version } from '@renovatebot/pep440';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { CommandConstructorOptions, VersionCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

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

    async execute(executeArgs?: BaseExecuteArgs): Promise<Pep440Version | undefined> {
        let parsedVersion: Pep440Version | undefined;

        const parser = (output: string): void => {
            // "pip X.Y.Z from /path/to/pip (python X.Y)"
            const match = output.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
            parsedVersion = match ? (parsePep440Version(match[1]) ?? undefined) : undefined;
        };

        const args = this.buildCommand();

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            executeArgs?.cancellationToken,
            this.timeout,
        );

        parser(output);
        return parsedVersion;
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

    async execute(executeArgs?: BaseExecuteArgs): Promise<Pep440Version | undefined> {
        let parsedVersion: Pep440Version | undefined;

        const parser = (output: string): void => {
            // "uv X.Y.Z" format
            const match = output.match(/(\d+\.\d+(?:\.\d+)*)/);
            parsedVersion = match ? (parsePep440Version(match[1]) ?? undefined) : undefined;
        };

        const args = this.buildCommand();

        const output = await runUV(args, undefined, this.log, executeArgs?.cancellationToken, this.timeout);

        parser(output);
        return parsedVersion;
    }
}
