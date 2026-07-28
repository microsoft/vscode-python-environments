import { AvailableVersionsCommand, type AvailableVersionsExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

/**
 * Pip available versions command.
 * Parsed command: `python -m pip index versions <package> --json --python-version <version>`
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
            '--python-version',
            executeArgs.pythonVersion,
        ];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]> {
        const output = await runPython(
            this.pythonExecutable,
            this.buildCommand(executeArgs),
            undefined,
            this.log,
            executeArgs.cancellationToken,
            this.timeout,
        );
        const match = output.match(/{[\s\S]*}/);
        if (!match) {
            return [];
        }

        try {
            const parsed = JSON.parse(match[0]) as { versions?: string[] };
            return this.filterVersions(
                Array.isArray(parsed.versions) ? parsed.versions : [],
                executeArgs.includePrerelease,
            );
        } catch {
            return [];
        }
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

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]> {
        const output = await runUV(
            this.buildCommand(executeArgs),
            undefined,
            this.log,
            executeArgs.cancellationToken,
            this.timeout,
        );
        const match = output.match(/{[\s\S]*}/);
        if (!match) {
            return [];
        }

        try {
            const parsed = JSON.parse(match[0]) as { versions?: string[] };
            return this.filterVersions(
                Array.isArray(parsed.versions) ? parsed.versions : [],
                executeArgs.includePrerelease,
            );
        } catch {
            return [];
        }
    }
}
