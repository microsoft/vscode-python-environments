import { CancellationToken, LogOutputChannel } from 'vscode';
import { PackageManagementOptions, PythonEnvironment } from '../../../api';
import { PipInstallCommand } from './install';
import { PipUninstallCommand } from './uninstall';

export type BuiltinManageCommandId = 'install' | 'uninstall';

export type BuiltinManageCommandPayloadById = {
    install: {
        packages: { packageName: string; version?: string }[];
        upgrade?: boolean;
    };
    uninstall: {
        packages: { packageName: string; version?: string }[];
    };
};

export type BuiltinManageCommand<T extends BuiltinManageCommandId = BuiltinManageCommandId> = {
    kind: T;
    payload: BuiltinManageCommandPayloadById[T];
};

export interface BuiltinCommandExecutionContext {
    log?: LogOutputChannel;
    cancellationToken?: CancellationToken;
}

/**
 * Converts external package management options into strict internal commands.
 */
export function toBuiltinManageCommands(options: PackageManagementOptions): BuiltinManageCommand[] {
    const commands: BuiltinManageCommand[] = [];

    if (options.uninstall && options.uninstall.length > 0) {
        commands.push({
            kind: 'uninstall',
            payload: {
                packages: options.uninstall.map((packageName) => ({ packageName })),
            },
        });
    }

    if (options.install && options.install.length > 0) {
        commands.push({
            kind: 'install',
            payload: {
                packages: options.install.map((packageName) => ({ packageName })),
                upgrade: options.upgrade,
            },
        });
    }

    return commands;
}

/**
 * Executes builtin package management commands using pip.
 * Instantiates command classes and invokes their execute methods.
 */
export class BuiltinCommandExecutor {
    async executeCommands(
        environment: PythonEnvironment,
        commands: BuiltinManageCommand[],
        context: BuiltinCommandExecutionContext,
    ): Promise<void> {
        if (environment.version.startsWith('2.')) {
            throw new Error('Python 2.* is not supported (deprecated)');
        }

        const pythonExecutable = environment.execInfo?.run?.executable ?? 'python';

        for (const command of commands) {
            await this.executeCommand(pythonExecutable, command, context);
        }
    }

    private async executeCommand(
        pythonExecutable: string,
        command: BuiltinManageCommand,
        context: BuiltinCommandExecutionContext,
    ): Promise<void> {
        if (command.kind === 'install') {
            const installPayload = command.payload as BuiltinManageCommandPayloadById['install'];
            const install = new PipInstallCommand({
                pythonExecutable,
                log: context.log,
                cancellationToken: context.cancellationToken,
            });
            await install.execute(installPayload.packages, installPayload.upgrade);
            return;
        }

        if (command.kind === 'uninstall') {
            const uninstallPayload = command.payload as BuiltinManageCommandPayloadById['uninstall'];
            const uninstall = new PipUninstallCommand({
                pythonExecutable,
                log: context.log,
                cancellationToken: context.cancellationToken,
            });
            await uninstall.execute(uninstallPayload.packages);
            return;
        }
    }
}
