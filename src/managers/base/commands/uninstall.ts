import { BaseExecuteArgs, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for uninstall command execution (change per execution).
 */
export interface UninstallExecuteArgs extends BaseExecuteArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Template class for uninstall commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class UninstallCommand extends PackageManagerCommand {
    protected static readonly configSection = 'uninstallCommandArgs';

    protected abstract buildCommand(executeArgs: UninstallExecuteArgs): string[];

    abstract execute(executeArgs: UninstallExecuteArgs): Promise<void>;
}
