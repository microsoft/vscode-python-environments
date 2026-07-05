import { PackageInfo } from '../../../api';
import { runPython } from '../helpers';
import { CommandConstructorOptions, ListCommand } from '../../base/commands/index';

/**
 * Concrete poetry list command (using `poetry show`).
 * Builds poetry-specific show arguments, parses output, and returns PackageInfo[].
 */
export class PoetryListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(): string[] {
        return ['show', '--format=json'];
    }

    async execute(): Promise<PackageInfo[]> {
        const packages: PackageInfo[] = [];

        const parser = (output: string): void => {
            const json = JSON.parse(output);
            if (!Array.isArray(json)) {
                throw new Error('Invalid output from poetry show command');
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
