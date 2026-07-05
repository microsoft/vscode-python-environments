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
 * Concrete poetry availableVersions command.
 * Builds poetry-specific arguments, parses output, and returns available version strings.
 */
export class PoetryAvailableVersionsCommand extends AvailableVersionsCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[] {
        // Poetry's search command to find available versions
        // Format: poetry search <package> [--json]
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
                if (Array.isArray(json) && json.length > 0) {
                    const pkg = json[0];
                    if (pkg.versions && Array.isArray(pkg.versions)) {
                        let filtered = pkg.versions.map((v: any) => v.version || v);
                        if (!includePrerelease) {
                            filtered = filtered.filter((v: string) => !v.includes('-') && !v.includes('rc'));
                        }
                        versions.push(...filtered);
                    }
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
