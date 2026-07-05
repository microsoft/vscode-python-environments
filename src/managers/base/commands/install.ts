import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for install command execution (change per execution).
 */
export interface InstallExecuteArgs {
    packages: { packageName: string; version?: string }[];
    upgrade?: boolean;
}

/**
 * Template class for install commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class InstallCommand extends PackageManagerCommand {
    protected config = getConfiguration('python-envs.packageManager.installCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected abstract buildCommand(executeArgs: InstallExecuteArgs): string[];

    abstract execute(executeArgs: InstallExecuteArgs): Promise<void>;
}
