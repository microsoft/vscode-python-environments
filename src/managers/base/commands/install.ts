import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Ephemeral arguments for install command (change per execution).
 */
export interface InstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
    upgrade?: boolean;
}

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

    protected abstract buildCommand(ephemeralArgs: InstallEphemeralArgs): string[];

    abstract execute(ephemeralArgs: InstallEphemeralArgs): Promise<void>;
}
