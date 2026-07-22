import type { Pep440Version } from '@renovatebot/pep440';
import { BaseExecuteArgs, PackageManagerCommand } from './packageManagerCommand';

/**
 * Template class for version commands.
 * Subclasses implement concrete package-manager-specific logic.
 */
export abstract class VersionCommand extends PackageManagerCommand {
    protected static readonly configSection = 'versionCommandArgs';

    abstract execute(executeArgs?: BaseExecuteArgs): Promise<Pep440Version | undefined>;
}
