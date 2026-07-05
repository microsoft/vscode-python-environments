import { PackageInfo } from '../../../api';
import { runPython } from '../helpers';
import { CommandConstructorOptions, ListCommand } from '../../base/commands/index';

/**
 * Concrete conda list command.
 * Builds conda-specific list arguments, parses output, and returns PackageInfo[].
 */
export class CondaListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['list', '--json'];
    }

    async execute(): Promise<PackageInfo[]> {
        const packages: PackageInfo[] = [];

        const parser = (output: string): void => {
            const json = JSON.parse(output);
            if (!Array.isArray(json)) {
                throw new Error('Invalid output from conda list command');
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
