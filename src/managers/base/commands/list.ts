import { PackageInfo } from '../../../api';
import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for list commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class ListCommand extends PackageManagerCommand {
    protected timeout: number = 300000;
    protected config = getConfiguration('python-envs.packageManager.listCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<PackageInfo[]>;
}
