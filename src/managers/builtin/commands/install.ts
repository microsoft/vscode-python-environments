import { getConfiguration } from '../../../common/workspace.apis';
import { CommandConstructorOptions, InstallCommand, type InstallExecuteArgs } from '../../base/commands/index';
import { runPython } from '../helpers';
import { processEditableInstallArgs } from '../utils';

/**
 * Pip install command.
 *
 * Parsed Command: `python -m pip install [--upgrade] [--index-url <url>] <package>`
 *
 * Official Documentation: https://pip.pypa.io/en/stable/cli/pip_install/
 * The `pip install` command installs packages from the Python Package Index (PyPI).
 * Supports version pinning via `package==version` syntax and index URL configuration.
 */
export class PipInstallCommand extends InstallCommand {
    private indexUrl?: string;

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager');
        this.indexUrl = config.get<string>('indexUrl');
    }

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        let args = ['-m', 'pip', 'install'];

        if (this.indexUrl) {
            args.push('--index-url', this.indexUrl);
        }

        if (executeArgs.upgrade) {
            args.push('--upgrade');
        }

        const processedArgs = processEditableInstallArgs(executeArgs.packages.map((pkg) => pkg.packageName));
        args.push(...processedArgs);

        return args;
    }

    async execute(executeArgs: InstallExecuteArgs): Promise<void> {
        const args = this.buildCommand(executeArgs);

        await runPython(this.pythonExecutable, args, undefined, this.log, this.cancellationToken, this.timeout);
    }
}

/**
 * UV install command.
 *
 * Parsed Command: `uv pip install --python <path> [--upgrade] [--index-url <url>] <package>`
 *
 * Official Documentation: https://docs.astral.sh/uv/pip/
 * The `uv pip install` command is UV's high-performance Python package installer.
 * UV is a Rust-based pip replacement that's faster than traditional pip.
 * The `--python` flag specifies the target Python interpreter.
 */
export class UvInstallCommand extends InstallCommand {
    private indexUrl?: string;

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager');
        this.indexUrl = config.get<string>('indexUrl');
    }

    protected buildCommand(executeArgs: InstallExecuteArgs): string[] {
        let args = ['pip', 'install', '--python', this.pythonExecutable];

        if (this.indexUrl) {
            args.push('--index-url', this.indexUrl);
        }

        if (executeArgs.upgrade) {
            args.push('--upgrade');
        }

        const processedArgs = processEditableInstallArgs(executeArgs.packages.map((pkg) => pkg.packageName));
        args.push(...processedArgs);

        return args;
    }

    async execute(executeArgs: InstallExecuteArgs): Promise<void> {
        const args = this.buildCommand(executeArgs);

        await runPython(this.pythonExecutable, args, undefined, this.log, this.cancellationToken, this.timeout);
    }
}
