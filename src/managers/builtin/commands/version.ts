import type { Pep440Version } from '@renovatebot/pep440';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { VersionCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

/**
 * Pip version command.
 * Parsed command: `python -m pip --version`
 * Official documentation: https://pip.pypa.io/en/stable/cli/pip/
 */
export class PipVersionCommand extends VersionCommand {
    protected buildCommand(): string[] {
        return ['-m', 'pip', '--version'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<Pep440Version | undefined> {
        const output = await runPython(
            this.pythonExecutable,
            this.buildCommand(),
            undefined,
            this.log,
            executeArgs?.cancellationToken,
            this.timeout,
        );

        const match = output.match(/^pip\s+(\d+\.\d+(?:\.\d+)*)/);
        return match ? (parsePep440Version(match[1]) ?? undefined) : undefined;
    }
}

/**
 * UV version command.
 * Parsed command: `uv --version`
 * Official documentation: https://docs.astral.sh/uv/
 */
export class UvVersionCommand extends VersionCommand {
    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(): Promise<Pep440Version | undefined> {
        const output = await runUV(this.buildCommand(), undefined, this.log, undefined, this.timeout);

        const match = output.match(/(\d+\.\d+(?:\.\d+)*)/);
        return match ? (parsePep440Version(match[1]) ?? undefined) : undefined;
    }
}
