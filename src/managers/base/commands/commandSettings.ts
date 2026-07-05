import { CancellationToken, LogOutputChannel } from 'vscode';

/**
 * Result type for commands that parse output and return data.
 */
export interface CommandResult<T> {
    readonly data: T;
    readonly rawOutput: string;
}

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

    constructor(options: CommandConstructorOptions) {
        this.pythonExecutable = options.pythonExecutable;
        this.log = options.log;
        this.cancellationToken = options.cancellationToken;
    }

    /**
     * Subclasses implement to build the command arguments.
     */
    protected abstract buildCommand(ephemeralArgs: unknown): string[];
}
