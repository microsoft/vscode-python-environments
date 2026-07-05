import { CommandConstructorOptions, PackageManagerCommand } from './commandSettings';

/**
 * Template class for uninstall commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class UninstallCommand extends PackageManagerCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    abstract execute(packages: { packageName: string; version?: string }[]): Promise<void>;
}
