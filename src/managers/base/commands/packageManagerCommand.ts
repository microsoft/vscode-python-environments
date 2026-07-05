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
    configSection?: string;
    log?: LogOutputChannel;
}

/**
 * Base class for all package manager commands.
 * Provides common properties and minimal interface for subclasses.
 */
export abstract class PackageManagerCommand {
    protected pythonExecutable: string;
    protected log?: LogOutputChannel;
    protected timeout: number = 300000;
    protected config: WorkspaceConfiguration;

    constructor(options: CommandConstructorOptions) {
        this.pythonExecutable = options.pythonExecutable;
        this.log = options.log;
        this.config = options.configSection
            ? getConfiguration(`python-envs.packageManager.${options.configSection}`)
            : getConfiguration('python-envs.packageManager');
    }

    /**
     * Subclasses implement to build the command arguments.
     */
    protected abstract buildCommand(executeArgs: BaseExecuteArgs): string[];
}
