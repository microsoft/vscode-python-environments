import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Ephemeral arguments for available versions command (change per execution).
 */
export interface AvailableVersionsEphemeralArgs {
    packageName: string;
    pythonVersion: string;
    includePrerelease?: boolean;
}

/**
 * Template class for availableVersions commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class AvailableVersionsCommand extends PackageManagerCommand {
    protected timeout: number = 300000;
    protected config = getConfiguration('python-envs.packageManager.availableVersionsCommandArgs');

    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected abstract buildCommand(ephemeralArgs: AvailableVersionsEphemeralArgs): string[];

    abstract execute(packageName: string, pythonVersion: string, includePrerelease?: boolean): Promise<string[]>;
}
