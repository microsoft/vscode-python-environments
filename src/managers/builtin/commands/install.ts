import { getConfiguration } from '../../../common/workspace.apis';
import { runPython } from '../helpers';
import { processEditableInstallArgs } from '../utils';
import { CommandConstructorOptions, InstallCommand } from '../../base/commands/index';

/**
 * Ephemeral arguments for install command (change per execution).
 */
interface InstallEphemeralArgs {
    packages: { packageName: string; version?: string }[];
    upgrade?: boolean;
}

/**
 * Concrete pip install command.
 * Builds pip-specific install arguments and executes via runPython.
 */
export class PipInstallCommand extends InstallCommand {
    private indexUrl?: string;

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager');
        this.indexUrl = config.get<string>('indexUrl');
    }

    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        let args = ['-m', 'pip', 'install'];

        if (this.indexUrl) {
            args.push('--index-url', this.indexUrl);
        }

        if (ephemeralArgs.upgrade) {
            args.push('--upgrade');
        }

        const processedArgs = processEditableInstallArgs(
            ephemeralArgs.packages.map((pkg) => pkg.packageName),
        );
        args.push(...processedArgs);

        return args;
    }

    async execute(
        packages: { packageName: string; version?: string }[],
        upgrade?: boolean,
    ): Promise<void> {
        const args = this.buildCommand({ packages, upgrade });

        await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );
    }
}

/**
 * Concrete uv install command.
 * Builds uv-specific install arguments and executes via runPython.
 */
export class UvInstallCommand extends InstallCommand {
    private indexUrl?: string;

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager');
        this.indexUrl = config.get<string>('indexUrl');
    }

    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        let args = ['pip', 'install'];

        if (this.indexUrl) {
            args.push('--index-url', this.indexUrl);
        }

        if (ephemeralArgs.upgrade) {
            args.push('--upgrade');
        }

        const processedArgs = processEditableInstallArgs(
            ephemeralArgs.packages.map((pkg) => pkg.packageName),
        );
        args.push(...processedArgs);

        return args;
    }

    async execute(
        packages: { packageName: string; version?: string }[],
        upgrade?: boolean,
    ): Promise<void> {
        const args = this.buildCommand({ packages, upgrade });

        await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );
    }
}
