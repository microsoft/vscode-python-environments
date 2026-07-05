import { PackageInfo } from '../../../api';
import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for list commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<PackageInfo[]>;
}
