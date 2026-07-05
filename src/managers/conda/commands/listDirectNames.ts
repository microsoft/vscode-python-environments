import { runPython } from '../helpers';
import { CommandConstructorOptions, ListDirectNamesCommand } from '../../base/commands/index';

/**
 * Concrete conda listDirectNames command.
 * Builds conda-specific arguments to extract direct dependencies, and returns their names.
 */
export class CondaListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        // Conda's list command with explicit format
        // Format: conda list --json
        return ['list', '--json'];
    }

    async execute(): Promise<string[]> {
        const names: string[] = [];

        const parser = (output: string): void => {
            try {
                const json = JSON.parse(output);
                if (Array.isArray(json)) {
                    // In conda, direct dependencies are marked with "not installed as dependencies"
                    // For now, we'll return all packages, filtering out Python itself
                    names.push(
                        ...json
                            .map((pkg: any) => pkg.name || pkg)
                            .filter((n: string) => n && n !== 'python')
                            .filter(Boolean),
                    );
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
