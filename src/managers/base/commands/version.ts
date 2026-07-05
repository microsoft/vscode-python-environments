import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for version commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class VersionCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'versionCommandArgs' });
    }

    abstract execute(): Promise<string>;
}
