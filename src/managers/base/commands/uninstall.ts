import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, CommandSettings, PackageManagerCommand } from './commandSettings';

/**
 * Template class for uninstall commands.
 * Loads uninstall-specific settings from VS Code configuration.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class UninstallCommand extends PackageManagerCommand {
    protected settings: CommandSettings;

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager.uninstallCommandArgs');
        this.settings = {
            executionTimeout: config.get<number>('executionTimeout', 300000),
            verboseOutput: config.get<boolean>('verboseOutput', false),
            retryOnFailure: config.get<boolean>('retryOnFailure', true),
            maxRetries: config.get<number>('maxRetries', 1),
        };
    }

    abstract execute(packages: { packageName: string; version?: string }[]): Promise<void>;
}
