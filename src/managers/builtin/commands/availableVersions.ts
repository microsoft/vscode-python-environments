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
 * Concrete pip availableVersions command.
 * Builds pip-specific availableVersions arguments, parses JSON output, and returns version strings.
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
            this.settings.executionTimeout,
        );

        parser(output);
        return availableVersions;
    }
}

/**
 * Concrete uv availableVersions command.
 * Builds uv-specific availableVersions arguments, parses JSON output, and returns version strings.
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
            this.settings.executionTimeout,
        );

        parser(output);
        return availableVersions;
    }
}
