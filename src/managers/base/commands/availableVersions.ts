import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for availableVersions commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class AvailableVersionsCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(packageName: string, pythonVersion: string, includePrerelease?: boolean): Promise<string[]>;
}
