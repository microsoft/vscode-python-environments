import type { Pep440Version } from '@renovatebot/pep440';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { BaseExecuteArgs, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for available versions command execution (change per execution).
 */
export interface AvailableVersionsExecuteArgs extends BaseExecuteArgs {
    packageName: string;
    pythonVersion: string;
    includePrerelease?: boolean;
}

/**
 * Template class for availableVersions commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class AvailableVersionsCommand extends PackageManagerCommand {
    protected static readonly configSection = 'availableVersionsCommandArgs';
    protected abstract buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[];
    protected parseVersions(versions: string[], includePrerelease?: boolean): Pep440Version[] {
        let parsed = Array.from(new Set(versions))
            .map((version) => parsePep440Version(version.trim()))
            .filter((version): version is Pep440Version => version !== null);
        if (includePrerelease === false) {
            parsed = parsed.filter((version) => !/[ab]|rc|dev/i.test(version.public));
        }
        return parsed;
    }
    abstract execute(executeArgs: AvailableVersionsExecuteArgs): Promise<Pep440Version[]>;
}
