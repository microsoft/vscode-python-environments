import { PackageInfo } from '../../../api';
import { BaseExecuteArgs, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for list commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListCommand extends PackageManagerCommand {
    protected static readonly configSection = 'listCommandArgs';

    abstract execute(executeArgs?: BaseExecuteArgs): Promise<PackageInfo[]>;
}
