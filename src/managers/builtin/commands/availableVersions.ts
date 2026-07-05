import { AvailableVersionsCommand, CommandConstructorOptions } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Ephemeral arguments for availableVersions command (change per execution).
 */
interface AvailableVersionsEphemeralArgs {
    packageName: string;
    pythonVersion: string;
    includePrerelease?: boolean;
}

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
    protected buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[] {
        const baseVersion = ephemeralArgs.pythonVersion.split('.').slice(0, 2).join('.');
        return ['-m', 'pip', 'index', 'versions', ephemeralArgs.packageName, '--json', '--python-version', baseVersion];
    }

    async execute(packageName: string, pythonVersion: string, includePrerelease?: boolean): Promise<string[]> {
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
                if (!includePrerelease) {
                    versions = versions.filter((version) => !/[ab]|rc|dev/i.test(version));
                }
                availableVersions = versions;
            } catch {
                availableVersions = [];
            }
        };

        const args = this.buildCommand({ packageName, pythonVersion, includePrerelease });

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            300000,
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

    protected buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[] {
        const baseVersion = ephemeralArgs.pythonVersion.split('.').slice(0, 2).join('.');
        return ['pip', 'index', 'versions', ephemeralArgs.packageName, '--json', '--python-version', baseVersion];
    }

    async execute(packageName: string, pythonVersion: string, includePrerelease?: boolean): Promise<string[]> {
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
                if (!includePrerelease) {
                    versions = versions.filter((version) => !/[ab]|rc|dev/i.test(version));
                }
                availableVersions = versions;
            } catch {
                availableVersions = [];
            }
        };

        const args = this.buildCommand({ packageName, pythonVersion, includePrerelease });

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            300000,
        );

        parser(output);
        return availableVersions;
    }
}
