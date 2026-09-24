import { PackageInfo } from '../../../api';
import { ListCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

/**
 * Pip list command.
 * Parsed command: `python -m pip list --format=json` --disable-pip-version-check
 * Official documentation: https://pip.pypa.io/en/stable/cli/pip_list/
 */
export class PipListCommand extends ListCommand {
    protected buildCommand(): string[] {
        return ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]> {
        const output = await runPython(
            this.pythonExecutable,
            this.buildCommand(),
            undefined,
            this.log,
            executeArgs?.cancellationToken,
            this.timeout,
        );
        let json: unknown;
        try {
            json = JSON.parse(output);
        } catch (e) {
            this.log?.error(`Failed to parse pip list output: ${e}`);
            return [];
        }
        if (!Array.isArray(json)) {
            this.log?.error('Invalid output from pip list command');
            return [];
        }

        return json
            .filter(({ name, version }) => !!name && !!version)
            .map(({ name, version }) => ({
                name,
                version,
                displayName: name,
                description: version,
            }));
    }
}

/**
 * UV list command.
 * Parsed command: `uv pip list --format=json --python <path>`
 * Official documentation: https://docs.astral.sh/uv/pip/
 */
export class UvListCommand extends ListCommand {
    protected buildCommand(): string[] {
        return ['pip', 'list', '--format=json', '--python', this.pythonExecutable];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]> {
        const output = await runUV(
            this.buildCommand(),
            undefined,
            this.log,
            executeArgs?.cancellationToken,
            this.timeout,
        );
        let json: unknown;
        try {
            json = JSON.parse(output);
        } catch (e) {
            this.log?.error(`Failed to parse uv pip list output: ${e}`);
            return [];
        }
        if (!Array.isArray(json)) {
            this.log?.error('Invalid output from uv pip list command');
            return [];
        }

        return json
            .filter(({ name, version }) => !!name && !!version)
            .map(({ name, version }) => ({
                name,
                version,
                displayName: name,
                description: version,
            }));
    }
}
