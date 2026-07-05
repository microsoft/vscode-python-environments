import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for uninstall command execution (change per execution).
 */
export interface UninstallExecuteArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Template class for uninstall commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class UninstallCommand extends PackageManagerCommand {
    protected config = getConfiguration('python-envs.packageManager.uninstallCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected abstract buildCommand(executeArgs: UninstallExecuteArgs): string[];

    abstract execute(executeArgs: UninstallExecuteArgs): Promise<void>;
}
