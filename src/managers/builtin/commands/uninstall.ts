import { CommandConstructorOptions, UninstallCommand, type UninstallExecuteArgs } from '../../base/commands/index';
import { runPython, runUV, shouldUseUv } from '../helpers';

/**
 * Pip uninstall command.
 *
 * Parsed Command: `python -m pip uninstall -y <package>`
 *
 * Official Documentation: https://pip.pypa.io/en/stable/cli/pip_uninstall/
 * The `pip uninstall` command uninstalls installed packages from the current environment.
 * The `-y` flag automatically confirms the uninstallation without prompting.
 */
export class PipUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }
    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        return ['-m', 'pip', 'uninstall', '-y', ...executeArgs.packages.map((pkg) => pkg.packageName)];
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
        const args = this.buildCommand(executeArgs);

        await runPython(this.pythonExecutable, args, undefined, this.log, executeArgs.cancellationToken, this.timeout);
    }
}

/**
 * UV uninstall command.
 *
 * Parsed Command: `uv pip uninstall -y --python <path> <package>`
 *
 * Official Documentation: https://docs.astral.sh/uv/pip/
 * The `uv pip uninstall` command removes packages from the Python environment via UV.
 * The `-y` flag automatically confirms uninstallation without prompting.
 * The `--python` flag specifies the target Python interpreter.
 */
export class UvUninstallCommand extends UninstallCommand {
    constructor(options: CommandConstructorOptions) {
        super(options);
    }

    protected buildCommand(executeArgs: UninstallExecuteArgs): string[] {
        const args = ['pip', 'uninstall', '-y', '--python', this.pythonExecutable];
        args.push(...executeArgs.packages.map((pkg) => pkg.packageName));
        return args;
    }

    async execute(executeArgs: UninstallExecuteArgs): Promise<void> {
        const args = this.buildCommand(executeArgs);

        await runUV(args, undefined, this.log, executeArgs.cancellationToken, this.timeout);
    }
}

export async function BuiltinUninstallCommandFactory(options: CommandConstructorOptions): Promise<UninstallCommand> {
    if (await shouldUseUv(options.log, options.pythonExecutable)) {
        return new UvUninstallCommand(options);
    }
    return new PipUninstallCommand(options);
}
