import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for listDirectNames commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListDirectNamesCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'listDirectNamesCommandArgs' });
    }

    abstract execute(): Promise<string[]>;
}
