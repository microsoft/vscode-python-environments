import { BaseExecuteArgs, CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for install command execution (change per execution).
 */
export interface InstallExecuteArgs extends BaseExecuteArgs {
    packages: { packageName: string; version?: string }[];
    upgrade?: boolean;
}

/**
 * Template class for install commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class InstallCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'installCommandArgs' });
    }

    protected abstract buildCommand(executeArgs: InstallExecuteArgs): string[];

    abstract execute(executeArgs: InstallExecuteArgs): Promise<void>;
}
