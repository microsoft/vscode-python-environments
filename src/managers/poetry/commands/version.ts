import { CommandConstructorOptions, VersionCommand } from '../../base/commands/index';
import { getPoetryVersion } from '../poetryUtils';

/**
 * Poetry version command.
 *
 * Parsed Command: `poetry --version`
 *
 * Official Documentation: https://python-poetry.org/docs/cli/#options
 * The `--version` option displays the current version of Poetry.
 * Returns output in format: "Poetry (version X.Y.Z)" which is parsed to extract the version string.
 */
export class PoetryVersionCommand extends VersionCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['--version'];
    }

    async execute(): Promise<string> {
        try {
            // Poetry version is obtained via getPoetryVersion utility which handles poetry --version
            // We pass the pythonExecutable as the poetry path since it was set to the poetry executable
            const versionString = await getPoetryVersion(this.pythonExecutable);
            return versionString || '';
        } catch {
            return '';
        }
    }
}
