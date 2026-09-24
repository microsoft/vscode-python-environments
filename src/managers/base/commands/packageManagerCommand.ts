import { CancellationToken, LogOutputChannel, WorkspaceConfiguration } from 'vscode';
import { getConfiguration } from '../../../common/workspace.apis';

/**
 * Base interface for all command execute arguments.
 * Provides optional cancellation token that all commands can use.
 */
export interface BaseExecuteArgs {
    cancellationToken?: CancellationToken;
}

/**
 * Constructor options shared by all package manager commands.
 */
export interface CommandConstructorOptions {
    pythonExecutable: string;
    cwd?: string;
    log?: LogOutputChannel;
}

/**
 * Base class for all package manager commands.
 * Provides common properties and minimal interface for subclasses.
 */
export abstract class PackageManagerCommand {
    protected static readonly configSection?: string;

    protected pythonExecutable: string;
    protected cwd?: string;
    protected log?: LogOutputChannel;
    protected timeout: number | undefined;
    protected config?: WorkspaceConfiguration;

    constructor(options: CommandConstructorOptions) {
        this.pythonExecutable = options.pythonExecutable;
        this.cwd = options.cwd;
        this.log = options.log;
        const configSection = (this.constructor as typeof PackageManagerCommand).configSection;
        this.config = configSection ? getConfiguration(`python-envs.packageManager.${configSection}`) : undefined;
    }

    /**
     * Subclasses implement to build the command arguments.
     */
    protected abstract buildCommand(executeArgs: BaseExecuteArgs): string[];
}
