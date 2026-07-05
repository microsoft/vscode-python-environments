import { BaseExecuteArgs, CommandConstructorOptions, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for version commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class VersionCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super({ ...options, configSection: 'versionCommandArgs' });
    }

    abstract execute(executeArgs?: BaseExecuteArgs): Promise<string>;
}
