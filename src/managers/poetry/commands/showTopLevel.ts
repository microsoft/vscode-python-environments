import { CommandConstructorOptions, ListDirectNamesCommand } from '../../base/commands/index';
import { runPoetry } from '../poetryPackageManager';

/**
 * Poetry show --top-level command.
 *
 * Parsed Command: `poetry show --no-ansi --top-level`
 *
 * Official Documentation: https://python-poetry.org/docs/cli/#show
 * The `poetry show` command with `--top-level` flag displays only the top-level (directly installed)
 * packages. The `--no-ansi` flag disables ANSI color output for easier parsing.
 * This is useful for determining which packages were explicitly installed vs. dependencies.
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
