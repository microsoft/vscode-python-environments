import { CancellationToken, LogOutputChannel } from 'vscode';

export type CommandType = 'install' | 'uninstall' | 'list' | 'version' | 'availableVersions' | 'listDirectNames';

/**
 * Settings that apply to a specific package manager command.
 */
export interface CommandSettings {
    /**
     * Timeout in milliseconds for command execution. 0 = no timeout.
     */
    readonly executionTimeout: number;

    /**
     * Whether to include verbose output from the package manager command.
     */
    readonly verboseOutput: boolean;

    /**
     * Whether to retry a failed command once before raising an error.
     */
    readonly retryOnFailure: boolean;

    /**
     * Maximum number of retry attempts for failed operations.
     */
    readonly maxRetries: number;
}

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
