import { AvailableVersionsCommand, CommandConstructorOptions } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Ephemeral arguments for conda availableVersions command (change per execution).
 */
interface AvailableVersionsEphemeralArgs {
    packageName: string;
}

/**
 * Concrete conda availableVersions command.
 * Builds conda-specific availableVersions arguments, parses JSON output, and returns version strings.
 */
export class CondaAvailableVersionsCommand extends AvailableVersionsCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[] {
        return ['search', ephemeralArgs.packageName, '--json'];
    }

    async execute(packageName: string, _pythonVersion: string, _includePrerelease?: boolean): Promise<string[]> {
        const args = this.buildCommand({ packageName });
        const output = await runCondaExecutable(args, this.log, this.cancellationToken);

        try {
            const parsed = JSON.parse(output);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed[packageName])) {
                const uniqueVersions = new Map<string, string>();
                (parsed[packageName] as Array<{ version?: string }>)
                    .filter((entry) => !!entry.version?.trim())
                    .forEach((entry) => {
                        const version = entry.version!.trim();
                        if (!uniqueVersions.has(version)) {
                            uniqueVersions.set(version, version);
                        }
                    });

                return Array.from(uniqueVersions.values());
            }
            return [];
        } catch {
            return [];
        }
    }
}
