import { PackageInfo } from '../../../api';
import { CommandConstructorOptions, ListCommand } from '../../base/commands/index';
import { runPython } from '../helpers';

/**
 * Concrete pip list command.
 * Builds pip-specific list arguments, parses JSON output, and returns PackageInfo[].
 */
export class PipListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['-m', 'pip', 'list', '--format=json'];
    }

    async execute(): Promise<PackageInfo[]> {
        const packages: PackageInfo[] = [];

        const parser = (output: string): void => {
            const json = JSON.parse(output);
            if (!Array.isArray(json)) {
                throw new Error('Invalid output from pip list command');
            }
            const parsed = json
                .filter(({ name, version }) => name && version)
                .map(({ name, version }) => ({
                    name,
                    version,
                    displayName: name,
                    description: version,
                }));
            packages.push(...parsed);
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
        return packages;
    }
}

/**
 * Concrete uv list command.
 * Builds uv-specific list arguments, parses JSON output, and returns PackageInfo[].
 */
export class UvListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(): string[] {
        return ['pip', 'list', '--format=json'];
    }

    async execute(): Promise<PackageInfo[]> {
        const packages: PackageInfo[] = [];

        const parser = (output: string): void => {
            const json = JSON.parse(output);
            if (!Array.isArray(json)) {
                throw new Error('Invalid output from uv pip list command');
            }
            const parsed = json
                .filter(({ name, version }) => name && version)
                .map(({ name, version }) => ({
                    name,
                    version,
                    displayName: name,
                    description: version,
                }));
            packages.push(...parsed);
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
        return packages;
    }
}
