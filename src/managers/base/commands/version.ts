import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for version commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class VersionCommand extends PackageManagerCommand {
    protected config = getConfiguration('python-envs.packageManager.versionCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<string>;
}
