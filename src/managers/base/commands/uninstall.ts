import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Ephemeral arguments for uninstall command (change per execution).
 */
export interface UninstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
}

/**
 * Template class for uninstall commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class UninstallCommand extends PackageManagerCommand {
    protected timeout: number = 300000;
    protected config = getConfiguration('python-envs.packageManager.uninstallCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected abstract buildCommand(ephemeralArgs: UninstallEphemeralArgs): string[];

    abstract execute(ephemeralArgs: UninstallEphemeralArgs): Promise<void>;
}
