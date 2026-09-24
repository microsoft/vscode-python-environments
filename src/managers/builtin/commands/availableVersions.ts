import type { Pep440Version } from '@renovatebot/pep440';
import { AvailableVersionsCommand, type AvailableVersionsExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

function parseVersionsJson(output: string, tool: 'pip' | 'uv'): string[] {
    const parsed: unknown = JSON.parse(output);
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('versions' in parsed) ||
        !Array.isArray(parsed.versions) ||
        !parsed.versions.every((version) => typeof version === 'string')
    ) {
        throw new Error(`Unexpected package version JSON from ${tool}.`);
    }

    return parsed.versions;
}

/**
 * Pip available versions command.
 * Parsed command: `python -m pip index versions <package> --json --disable-pip-version-check --python-version <version>`
 * Official documentation: https://pip.pypa.io/en/stable/cli/pip_index/
 */
export class PipAvailableVersionsCommand extends AvailableVersionsCommand {
    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        return [
            '-m',
            'pip',
            'index',
            'versions',
            executeArgs.packageName,
            '--json',
            '--disable-pip-version-check',
            '--python-version',
            executeArgs.pythonVersion,
        ];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<Pep440Version[]> {
        const output = await runPython(
            this.pythonExecutable,
            this.buildCommand(executeArgs),
            undefined,
            this.log,
            executeArgs.cancellationToken,
            this.timeout,
        );
        return this.parseVersions(parseVersionsJson(output, 'pip'), executeArgs.includePrerelease);
    }
}

/**
 * Pip available versions command for Pip 21.2 through 25.0, before JSON output was supported.
 */
export class PipAvailableVersionsTextCommand extends AvailableVersionsCommand {
    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        return [
            '-m',
            'pip',
            'index',
            'versions',
            executeArgs.packageName,
            '--disable-pip-version-check',
            '--python-version',
            executeArgs.pythonVersion,
        ];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<Pep440Version[]> {
        const output = await runPython(
            this.pythonExecutable,
            this.buildCommand(executeArgs),
            undefined,
            this.log,
            executeArgs.cancellationToken,
            this.timeout,
        );
        const match = output.match(/^Available versions:\s*(.+)$/im);
        if (!match) {
            throw new Error('Unable to parse available package versions from pip output.');
        }
        return this.parseVersions(match[1].split(','), executeArgs.includePrerelease);
    }
}

/**
 * UV available versions command.
 * Parsed command: `uv tool run pip index versions <package> --json --python-version <version>`
 * Official documentation: https://docs.astral.sh/uv/pip/
 */
export class UvAvailableVersionsCommand extends AvailableVersionsCommand {
    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        return [
            'tool',
            'run',
            'pip',
            'index',
            'versions',
            executeArgs.packageName,
            '--json',
            '--python-version',
            executeArgs.pythonVersion,
        ];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<Pep440Version[]> {
        const output = await runUV(
            this.buildCommand(executeArgs),
            undefined,
            this.log,
            executeArgs.cancellationToken,
            this.timeout,
        );
        return this.parseVersions(parseVersionsJson(output, 'uv'), executeArgs.includePrerelease);
    }
}
