import { CancellationToken, LogOutputChannel } from 'vscode';

/**
 * Constructor options shared by all package manager commands.
 */
export interface CommandConstructorOptions {
    pythonExecutable: string;
    log?: LogOutputChannel;
    cancellationToken?: CancellationToken;
}

/**
 * Base class for all package manager commands.
 * Provides common properties and minimal interface for subclasses.
 */
export abstract class PackageManagerCommand {
    protected pythonExecutable: string;
    protected log?: LogOutputChannel;
    protected cancellationToken?: CancellationToken;
    protected timeout: number = 300000;

    constructor(options: CommandConstructorOptions) {
        this.pythonExecutable = options.pythonExecutable;
        this.log = options.log;
        this.cancellationToken = options.cancellationToken;
    }

    /**
     * Subclasses implement to build the command arguments.
     */
    protected abstract buildCommand(executeArgs: unknown): string[];
}
