import { ListDirectNamesCommand, type BaseExecuteArgs } from '../../base/commands/index';
import { normalizePackageName } from '../../common/packageUtils';
import { runPoetry } from './runPoetry';

/**
 * Poetry show --top-level command.
 * Parsed command: `poetry show --no-ansi --top-level`
 * Official documentation: https://python-poetry.org/docs/cli/#show
 */
export class PoetryShowTopLevelCommand extends ListDirectNamesCommand {
    protected buildCommand(): string[] {
        return ['show', '--no-ansi', '--top-level'];
    }

    async execute(executeArgs?: BaseExecuteArgs): Promise<Set<string>> {
        const output = await runPoetry(this.buildCommand(), this.cwd, this.log, executeArgs?.cancellationToken);

        try {
            const names = output
                .split('\n')
                .map((line) => line.trim())
                .map((line) => line.match(/^([a-zA-Z0-9._-]+)/)?.[1] ?? '')
                .filter((name) => !!name)
                .map(normalizePackageName);
            return new Set(names);
        } catch {
            return new Set();
        }
    }
}
