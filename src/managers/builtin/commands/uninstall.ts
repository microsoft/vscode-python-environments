import { UninstallCommand, type UninstallExecuteArgs } from '../../base/commands/index';
import { runPython, runUV } from '../helpers';

/**
 * Pip uninstall command.
 * Parsed command: `python -m pip uninstall -y <package>`
 * Official documentation: https://pip.pypa.io/en/stable/cli/pip_uninstall/
 */
export class PipUninstallCommand extends UninstallCommand {
    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        return ['-m', 'pip', 'uninstall', '-y', ...executeArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
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
 * UV uninstall command.
 * Parsed command: `uv pip uninstall -y --python <path> <package>`
 * Official documentation: https://docs.astral.sh/uv/pip/
 */
export class UvUninstallCommand extends UninstallCommand {
    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        const args = ['pip', 'uninstall', '--python', this.pythonExecutable];
        args.push(...executeArgs.packages.map((pkg) => pkg.packageName));
        return args;
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
        await runUV(this.buildCommand(executeArgs), undefined, this.log, executeArgs.cancellationToken, this.timeout);
    }
}
