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

    abstract execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]>;
}
