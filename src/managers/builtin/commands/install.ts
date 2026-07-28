import { InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';
import { processEditableInstallArgs } from '../utils';

/**
 * Pip install command.
 * Parsed command: `python -m pip install [--upgrade] <package>`
 * Official documentation: https://pip.pypa.io/en/stable/cli/pip_install/
 */
export class PipInstallCommand extends InstallCommand {
    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        let args = ['-m', 'pip', 'install'];
        if (executeArgs.upgrade) {
            args.push('--upgrade');
        }
        const processedArgs = processEditableInstallArgs(executeArgs.packages.map((pkg) => pkg.packageName));
        args.push(...processedArgs);
        return args;
    }

    async execute(executeArgs: InstallExecuteArgs): Promise<void> {
        await runPython(
            this.pythonExecutable,
            this.buildCommand(executeArgs),
            undefined,
            this.log,
            executeArgs.cancellationToken,
            this.timeout,
        );
    }
}

/**
 * UV install command.
 * Parsed command: `uv pip install --python <path> [--upgrade] <package>`
 * Official documentation: https://docs.astral.sh/uv/pip/
 */
export class UvInstallCommand extends InstallCommand {
    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        let args = ['pip', 'install', '--python', this.pythonExecutable];
        if (executeArgs.upgrade) {
            args.push('--upgrade');
        }
        const processedArgs = processEditableInstallArgs(executeArgs.packages.map((pkg) => pkg.packageName));
        args.push(...processedArgs);
        return args;
    }

    async execute(executeArgs: InstallExecuteArgs): Promise<void> {
        await runUV(this.buildCommand(executeArgs), undefined, this.log, executeArgs.cancellationToken, this.timeout);
    }
}
