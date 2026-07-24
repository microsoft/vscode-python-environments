import { CancellationToken, l10n, LogOutputChannel, ProgressLocation, window, WorkspaceConfiguration } from 'vscode';
import { getConfiguration } from '../../../common/workspace.apis';

/**
 * Base interface for all command execute arguments.
 * Provides optional cancellation token that all commands can use.
 */
export interface BaseExecuteArgs {
    cancellationToken?: CancellationToken;
    showProgress?: boolean;
}

/**
 * Constructor options shared by all package manager commands.
 */
export interface CommandConstructorOptions {
    pythonExecutable: string;
    log?: LogOutputChannel;
}

/**
 * Base class for all package manager commands.
 * Provides common properties and minimal interface for subclasses.
 */
export abstract class PackageManagerCommand {
    protected static readonly configSection?: string;

    protected pythonExecutable: string;
    protected log?: LogOutputChannel;
    protected timeout: number = 300000;
    protected config?: WorkspaceConfiguration;

    constructor(options: CommandConstructorOptions) {
        this.pythonExecutable = options.pythonExecutable;
        this.log = options.log;
        const configSection = (this.constructor as typeof PackageManagerCommand).configSection;
        this.config = configSection ? getConfiguration(`python-envs.packageManager.${configSection}`) : undefined;
    }

    /**
     * Executes this command and optionally wraps execution with a progress indicator.
     */
    public executeWithProgress<T = unknown, A extends BaseExecuteArgs = BaseExecuteArgs>(
        executeArgs?: A,
        title?: string,
    ): Promise<T> {
        if (!executeArgs?.showProgress) {
            return this.execute(executeArgs) as Promise<T>;
        }

        return Promise.resolve(
            window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: title ?? l10n.t('Running package manager command'),
                    cancellable: true,
                },
                (_progress, token) =>
                    this.execute({
                        ...executeArgs,
                        cancellationToken: executeArgs.cancellationToken ?? token,
                    }) as Promise<T>,
            ),
        );
    }

    /**
     * Subclasses implement command execution.
     */
    abstract execute(executeArgs?: BaseExecuteArgs): Promise<unknown>;

    /**
     * Subclasses implement to build the command arguments.
     */
    protected abstract buildCommand(executeArgs: BaseExecuteArgs): string[];
}
