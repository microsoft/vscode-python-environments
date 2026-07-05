import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for listDirectNames commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListDirectNamesCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<string[]>;
}
