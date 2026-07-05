import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Arguments for available versions command execution (change per execution).
 */
export interface AvailableVersionsExecuteArgs {
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

    protected abstract buildCommand(executeArgs: AvailableVersionsExecuteArgs): string[];

    abstract execute(executeArgs: AvailableVersionsExecuteArgs): Promise<string[]>;
}
