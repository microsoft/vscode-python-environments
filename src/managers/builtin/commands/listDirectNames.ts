import { ListDirectNamesCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { normalizePackageName } from '../../common/packageUtils';
import { runPython, runUV } from '../helpers';

/**
 * Pip list direct names command.
 * Parsed command: `python -m pip list --format=json --not-required`
 * Official documentation: https://pip.pypa.io/en/stable/cli/pip_list/
 */
export class PipListDirectNamesCommand extends ListDirectNamesCommand {
    protected buildCommand(): string[] {
        return ['-m', 'pip', 'list', '--format=json', '--not-required'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<Set<string>> {
        const output = await runPython(
            this.pythonExecutable,
            this.buildCommand(),
            undefined,
            this.log,
            executeArgs?.cancellationToken,
            this.timeout,
        );
        let packages: unknown;
        try {
            packages = JSON.parse(output);
        } catch (e) {
            this.log?.error(`Failed to parse pip list output: ${e}`);
            return new Set();
        }
        if (!Array.isArray(packages)) {
            this.log?.error('Invalid output from pip list command');
            return new Set();
        }

        return new Set(packages.filter(({ name }) => !!name).map(({ name }) => normalizePackageName(name)));
    }
}

/**
 * UV list direct names command.
 * Parsed command: `uv pip tree --python <python> --depth=0`
 * Official documentation: https://docs.astral.sh/uv/pip/
 */
export class UvListDirectNamesCommand extends ListDirectNamesCommand {
    protected buildCommand(): string[] {
        return ['pip', 'tree', '--python', this.pythonExecutable, '--depth=0'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<Set<string>> {
        const output = await runUV(
            this.buildCommand(),
            undefined,
            this.log,
            executeArgs?.cancellationToken,
            this.timeout,
        );
        const packageNames = new Set<string>();
        const lines = output.split('\n');

        for (const line of lines) {
            // Tree output has top-level packages at the start of the line with no indentation
            // Dependencies are indented with tree characters (├, └, │, etc.)
            // We only want lines that start with a package name (not whitespace or tree chars)
            if (line.length === 0 || /^[\s├└│]/.test(line)) {
                continue;
            }

            // Extract package name (first word, before space or end of line)
            const match = line.match(/^(\S+)/);
            if (match && match[1]) {
                packageNames.add(normalizePackageName(match[1]));
            }
        }

        return packageNames;
    }
}
