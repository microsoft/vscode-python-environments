import type { Pep440Version } from '@renovatebot/pep440';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { VersionCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { getPoetryVersion } from '../poetryUtils';

/**
 * Poetry version command.
 * Parsed command: `poetry --version`
 * Official documentation: https://python-poetry.org/docs/cli/#options
 */
export class PoetryVersionCommand extends VersionCommand {
    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(_executeArgs?: BaseExecuteArgs): Promise<Pep440Version | undefined> {
        try {
            // Poetry version is obtained via getPoetryVersion utility which handles poetry --version
            // We pass the pythonExecutable as the poetry path since it was set to the poetry executable
            const versionString = await getPoetryVersion(this.pythonExecutable);
            return versionString ? (parsePep440Version(versionString) ?? undefined) : undefined;
        } catch {
            return undefined;
        }
    }
}
