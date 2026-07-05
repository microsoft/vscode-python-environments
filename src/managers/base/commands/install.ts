import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for install commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class InstallCommand extends PackageManagerCommand {
    protected timeout: number = 300000;
    protected config = getConfiguration('python-envs.packageManager.installCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(packages: { packageName: string; version?: string }[], upgrade?: boolean): Promise<void>;
}
