import { CommandConstructorOptions, ListDirectNamesCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

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

    async execute(executeArgs?: BaseExecuteArgs): Promise<string[]> {
        let directNames: string[] = [];

        const parser = (output: string): void => {
            let packages: unknown;
            try {
                packages = JSON.parse(output);
            } catch (e) {
                this.log?.error(`Failed to parse pip list output: ${e}`);
                return;
            }
            if (!Array.isArray(packages)) {
                this.log?.error('Invalid output from pip list command');
                return;
            }
            directNames = packages.filter(({ name }) => name).map(({ name }) => name);
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
        return directNames;
    }
}

/**
 * UV list direct names command.
 *
 * Parsed Command: `uv pip list --format=json --not-required --python <path>`
 *
 * Official Documentation: https://docs.astral.sh/uv/pip/
 * The `uv pip list --not-required` command lists only top-level (directly installed) packages.
 * Excludes transitive dependencies that are installed as requirements of other packages.
 * The `--format=json` flag outputs results in JSON format for structured parsing.
 * The `--python` flag specifies the target Python interpreter.
 */
export class UvListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['pip', 'list', '--format=json', '--not-required', '--python', this.pythonExecutable];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<string[]> {
        let directNames: string[] = [];

        const parser = (output: string): void => {
            let packages: unknown;
            try {
                packages = JSON.parse(output);
            } catch (e) {
                this.log?.error(`Failed to parse uv pip list output: ${e}`);
                return;
            }
            if (!Array.isArray(packages)) {
                this.log?.error('Invalid output from uv pip list command');
                return;
            }
            directNames = packages.filter(({ name }) => name).map(({ name }) => name);
        };

        const args = this.buildCommand();

        const output = await runUV(args, undefined, this.log, executeArgs?.cancellationToken, this.timeout);

        parser(output);
        return directNames;
    }
}
