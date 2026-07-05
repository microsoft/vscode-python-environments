import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for version commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class VersionCommand extends PackageManagerCommand {
    protected timeout: number = 300000;
    protected config = getConfiguration('python-envs.packageManager.versionCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(): Promise<string>;
}
