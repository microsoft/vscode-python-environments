import { BaseExecuteArgs, CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

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
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'uninstallCommandArgs' });
    }

    protected abstract buildCommand(executeArgs: UninstallExecuteArgs): string[];

    abstract execute(executeArgs: UninstallExecuteArgs): Promise<void>;
}
