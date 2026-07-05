import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for install commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class InstallCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(packages: { packageName: string; version?: string }[], upgrade?: boolean): Promise<void>;
}
