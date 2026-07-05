import { PackageInfo } from '../../../api';
import { CommandConstructorOptions, ListCommand } from '../../base/commands/index';
import { runCondaExecutable } from '../condaUtils';

/**
 * Ephemeral arguments for conda list command (change per execution).
 */
interface ListEphemeralArgs {
    environmentPath: string;
}

/**
 * Concrete conda list command.
 * Builds conda-specific list arguments and returns PackageInfo[].
 */
export class CondaListCommand extends ListCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(ephemeralArgs: ListEphemeralArgs): string[] {
        return ['list', '-p', ephemeralArgs.environmentPath, '--json'];
    }

    async execute(environmentPath?: string): Promise<PackageInfo[]> {
        if (!environmentPath) {
            return [];
        }

        const args = this.buildCommand({ environmentPath });
        const output = await runCondaExecutable(args, this.log, this.cancellationToken);

        let condaPackages: { name: string; version: string }[];
        try {
            condaPackages = JSON.parse(output) as { name: string; version: string }[];
        } catch {
            return [];
        }

        const packages: PackageInfo[] = [];
        for (const condaPkg of condaPackages) {
            if (condaPkg.name && condaPkg.version) {
                packages.push({
                    name: condaPkg.name,
                    displayName: condaPkg.name,
                    version: condaPkg.version,
                    description: condaPkg.version,
                });
            }
        }

        return packages;
    }
}
