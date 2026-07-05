import { CommandConstructorOptions, ListDirectNamesCommand } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Pip list direct names command.
 *
 * Parsed Command: `python -m pip list --format=json --not-required`
 *
 * Official Documentation: https://pip.pypa.io/en/stable/cli/pip_list/
 * The `pip list --not-required` command lists only top-level (directly installed) packages.
 * Excludes transitive dependencies that are installed as requirements of other packages.
 * The `--format=json` flag outputs results in JSON format for structured parsing.
 */
export class PipListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['-m', 'pip', 'list', '--format=json', '--not-required'];
    }

    async execute(): Promise<string[]> {
        let directNames: string[] = [];

        const parser = (output: string): void => {
            const packages = JSON.parse(output);
            if (!Array.isArray(packages)) {
                throw new Error('Invalid output from pip list command');
            }
            directNames = packages.filter(({ name }) => name).map(({ name }) => name);
        };

        const args = this.buildCommand();

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.timeout,
        );

        parser(output);
        return directNames;
    }
}

/**
 * UV list direct names command.
 *
 * Parsed Command: `uv pip list --format=json --not-required`
 *
 * Official Documentation: https://docs.astral.sh/uv/pip/
 * The `uv pip list --not-required` command lists only top-level (directly installed) packages.
 * Excludes transitive dependencies that are installed as requirements of other packages.
 * The `--format=json` flag outputs results in JSON format for structured parsing.
 */
export class UvListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['pip', 'list', '--format=json', '--not-required'];
    }

    async execute(): Promise<string[]> {
        let directNames: string[] = [];

        const parser = (output: string): void => {
            const packages = JSON.parse(output);
            if (!Array.isArray(packages)) {
                throw new Error('Invalid output from uv pip list command');
            }
            directNames = packages.filter(({ name }) => name).map(({ name }) => name);
        };

        const args = this.buildCommand();

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.timeout,
        );

        parser(output);
        return directNames;
    }
}
