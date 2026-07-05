import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for listDirectNames commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListDirectNamesCommand extends PackageManagerCommand {
    protected config = getConfiguration('python-envs.packageManager.listDirectNamesCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<string[]>;
}
