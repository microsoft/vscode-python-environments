import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for version commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class VersionCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<string>;
}
