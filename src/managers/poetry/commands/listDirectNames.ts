import { runPython } from '../helpers';
import { CommandConstructorOptions, ListDirectNamesCommand } from '../../base/commands/index';

/**
 * Concrete poetry listDirectNames command.
 * Builds poetry-specific arguments to extract direct dependencies, and returns their names.
 */
export class PoetryListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        // Poetry's show command with --outdated to get direct dependencies
        // Format: poetry show --direct
        return ['show', '--direct', '--format=json'];
    }

    async execute(): Promise<string[]> {
        const names: string[] = [];

        const parser = (output: string): void => {
            try {
                const json = JSON.parse(output);
                if (Array.isArray(json)) {
                    names.push(...json.map((pkg: any) => pkg.name || pkg).filter(Boolean));
                }
            } catch {
                // If parsing fails, return empty
            }
        };

        const args = this.buildCommand();

        const output = await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );

        parser(output);
        return names;
    }
}
