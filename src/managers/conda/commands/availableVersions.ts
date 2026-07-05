import { runPython } from '../helpers';
import { CommandConstructorOptions, AvailableVersionsCommand } from '../../base/commands/index';

/**
 * Ephemeral arguments for availableVersions command (change per execution).
 */
interface AvailableVersionsEphemeralArgs {
    packageName: string;
    pythonVersion: string;
    includePrerelease?: boolean;
}

/**
 * Concrete conda availableVersions command.
 * Builds conda-specific arguments, parses output, and returns available version strings.
 */
export class CondaAvailableVersionsCommand extends AvailableVersionsCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[] {
        // Conda's search command
        // Format: conda search <package> --json
        const args = ['search', ephemeralArgs.packageName, '--json'];
        return args;
    }

    async execute(
        packageName: string,
        pythonVersion: string,
        includePrerelease?: boolean,
    ): Promise<string[]> {
        const versions: string[] = [];

        const parser = (output: string): void => {
            try {
                const json = JSON.parse(output);
                if (json[packageName] && Array.isArray(json[packageName])) {
                    let versionList = json[packageName].map((pkg: any) => pkg.version || pkg);
                    if (!includePrerelease) {
                        versionList = versionList.filter((v: string) => !v.includes('alpha') && !v.includes('beta') && !v.includes('rc'));
                    }
                    versions.push(...versionList);
                }
            } catch {
                // If parsing fails, return empty
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
        return versions;
    }
}
