import { CommandConstructorOptions, ListDirectNamesCommand } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Concrete pip listDirectNames command.
 * Builds pip-specific listDirectNames arguments, parses JSON output, and returns direct package names.
 */
export class PipListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['-m', 'pip', 'list', '--format=json', '--not-required'];
    }

    async execute(): Promise<string[]> {
        let directNames: string[] = [];

        const parser = (output: string): void => {
            const packages = JSON.parse(output);
            if (!Array.isArray(packages)) {
                throw new Error('Invalid output from pip list command');
            }
            directNames = packages.filter(({ name }) => name).map(({ name }) => name);
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
        return directNames;
    }
}

/**
 * Concrete uv listDirectNames command.
 * Builds uv-specific listDirectNames arguments, parses JSON output, and returns direct package names.
 */
export class UvListDirectNamesCommand extends ListDirectNamesCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['pip', 'list', '--format=json', '--not-required'];
    }

    async execute(): Promise<string[]> {
        let directNames: string[] = [];

        const parser = (output: string): void => {
            const packages = JSON.parse(output);
            if (!Array.isArray(packages)) {
                throw new Error('Invalid output from uv pip list command');
            }
            directNames = packages.filter(({ name }) => name).map(({ name }) => name);
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
        return directNames;
    }
}
