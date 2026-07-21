import { BaseExecuteArgs, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for listDirectNames commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListDirectNamesCommand extends PackageManagerCommand {
    protected static readonly configSection = 'listDirectNamesCommandArgs';

    abstract execute(executeArgs?: BaseExecuteArgs): Promise<string[]>;
}
