import { CommandConstructorOptions, ListDirectNamesCommand } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

/**
 * Concrete poetry show --top-level command.
 * Builds poetry-specific show command and returns top-level package names.
 */
export class PoetryShowTopLevelCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['show', '--no-ansi', '--top-level'];
    }

    async execute(): Promise<string[]> {
        const args = this.buildCommand();
        const output = await runPoetry(args, undefined, this.log, this.cancellationToken);

        try {
            const names = output
                .split('\n')
                .map((line) => line.trim())
                .map((line) => line.match(/^([a-zA-Z0-9._-]+)/)?.[1] ?? '')
                .filter((name) => !!name);
            return names;
        } catch {
            return [];
        }
    }
}
