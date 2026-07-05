import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for available versions command execution (change per execution).
 */
export interface AvailableVersionsExecuteArgs {
    packageName: string;
    pythonVersion: string;
    includePrerelease?: boolean;
}

/**
 * Template class for availableVersions commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class AvailableVersionsCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'availableVersionsCommandArgs' });
    }

    protected abstract buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[];

    abstract execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]>;
}
