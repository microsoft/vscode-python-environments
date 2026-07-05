import {
    AvailableVersionsCommand,
    CommandConstructorOptions,
    type AvailableVersionsExecuteArgs,
} from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Pip available versions command.
 *
 * Parsed Command: `python -m pip index versions <package> --json --python-version <version>`
 *
 * Official Documentation: https://pip.pypa.io/en/stable/cli/pip_index/
 * The `pip index versions` command lists all available versions of a package on PyPI.
 * The `--python-version` flag filters versions compatible with the specified Python version.
 * The `--json` flag outputs results in JSON format for structured parsing.
 */
export class PipAvailableVersionsCommand extends AvailableVersionsCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        const baseVersion = executeArgs.pythonVersion.split('.').slice(0, 2).join('.');
        return ['-m', 'pip', 'index', 'versions', executeArgs.packageName, '--json', '--python-version', baseVersion];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]> {
        let availableVersions: string[] = [];

        const parser = (output: string): void => {
            const match = output.match(/{[\s\S]*}/);
            if (!match) {
                availableVersions = [];
                return;
            }
            try {
                const parsed = JSON.parse(match[0]) as { versions?: string[] };
                let versions = Array.isArray(parsed.versions) ? parsed.versions.filter((v) => !!v.trim()) : [];
                if (!executeArgs.includePrerelease) {
                    versions = versions.filter((version) => !/[ab]|rc|dev/i.test(version));
                }
                availableVersions = versions;
            } catch {
                availableVersions = [];
            }
        };

        const args = this.buildCommand(executeArgs);

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.timeout,
        );

        parser(output);
        return availableVersions;
    }
}

/**
 * UV available versions command.
 *
 * Parsed Command: `uv pip index versions <package> --json --python-version <version>`
 *
 * Official Documentation: https://docs.astral.sh/uv/pip/
 * The `uv pip index versions` command lists all available versions of a package.
 * The `--python-version` flag filters versions compatible with the specified Python version.
 * The `--json` flag outputs results in JSON format for structured parsing.
 */
export class UvAvailableVersionsCommand extends AvailableVersionsCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[] {
        const baseVersion = executeArgs.pythonVersion.split('.').slice(0, 2).join('.');
        return ['pip', 'index', 'versions', executeArgs.packageName, '--json', '--python-version', baseVersion];
    }

    async execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]> {
        let availableVersions: string[] = [];

        const parser = (output: string): void => {
            const match = output.match(/{[\s\S]*}/);
            if (!match) {
                availableVersions = [];
                return;
            }
            try {
                const parsed = JSON.parse(match[0]) as { versions?: string[] };
                let versions = Array.isArray(parsed.versions) ? parsed.versions.filter((v) => !!v.trim()) : [];
                if (!executeArgs.includePrerelease) {
                    versions = versions.filter((version) => !/[ab]|rc|dev/i.test(version));
                }
                availableVersions = versions;
            } catch {
                availableVersions = [];
            }
        };

        const args = this.buildCommand(executeArgs);

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.timeout,
        );

        parser(output);
        return availableVersions;
    }
}
