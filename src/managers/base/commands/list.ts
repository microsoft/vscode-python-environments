import { PackageInfo } from '../../../api';
import { BaseExecuteArgs, CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for list commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'listCommandArgs' });
    }

    abstract execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]>;
}
