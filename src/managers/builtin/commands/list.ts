import { PackageInfo } from '../../../api';
import { CommandConstructorOptions, ListCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

/**
 * Pip list command.
 *
 * Parsed Command: `python -m pip list --format=json`
 *
 * Official Documentation: https://pip.pypa.io/en/stable/cli/pip_list/
 * The `pip list` command shows all installed packages in the current environment.
 * The `--format=json` flag outputs the list in JSON format for structured parsing.
 */
export class PipListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['-m', 'pip', 'list', '--format=json'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]> {
        const packages: PackageInfo[] = [];

        const parser = (output: string): void => {
            let json: unknown;
            try {
                json = JSON.parse(output);
            } catch (e) {
                this.log?.error(`Failed to parse pip list output: ${e}`);
                return;
            }
            if (!Array.isArray(json)) {
                this.log?.error('Invalid output from pip list command');
                return;
            }
            const parsed = json
                .filter(({ name, version }) => name && version)
                .map(({ name, version }) => ({
                    name,
                    version,
                    displayName: name,
                    description: version,
                }));
            packages.push(...parsed);
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
        return packages;
    }
}

/**
 * UV list command.
 *
 * Parsed Command: `uv pip list --format=json --python <path>`
 *
 * Official Documentation: https://docs.astral.sh/uv/pip/
 * The `uv pip list` command shows all installed packages via UV's pip interface.
 * The `--python` flag specifies the target Python interpreter.
 * The `--format=json` flag outputs the list in JSON format for structured parsing.
 */
export class UvListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['pip', 'list', '--format=json', '--python', this.pythonExecutable];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]> {
        const packages: PackageInfo[] = [];

        const parser = (output: string): void => {
            let json: unknown;
            try {
                json = JSON.parse(output);
            } catch (e) {
                this.log?.error(`Failed to parse uv pip list output: ${e}`);
                return;
            }
            if (!Array.isArray(json)) {
                this.log?.error('Invalid output from uv pip list command');
                return;
            }
            const parsed = json
                .filter(({ name, version }) => name && version)
                .map(({ name, version }) => ({
                    name,
                    version,
                    displayName: name,
                    description: version,
                }));
            packages.push(...parsed);
        };

        const args = this.buildCommand();

        const output = await runUV(args, undefined, this.log, executeArgs?.cancellationToken, this.timeout);

        parser(output);
        return packages;
    }
}
