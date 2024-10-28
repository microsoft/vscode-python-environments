import {
    Disposable,
    EventEmitter,
    ProgressLocation,
    Terminal,
    TerminalShellExecutionEndEvent,
    TerminalShellExecutionStartEvent,
    TerminalShellIntegrationChangeEvent,
    Uri,
} from 'vscode';
import {
    createTerminal,
    onDidChangeTerminalShellIntegration,
    onDidCloseTerminal,
    onDidEndTerminalShellExecution,
    onDidOpenTerminal,
    onDidStartTerminalShellExecution,
    withProgress,
} from '../../common/window.apis';
import { IconPath, PythonEnvironment } from '../../api';
import { isActivatableEnvironment } from './activation';
import { showErrorMessage } from '../../common/errors/utils';

function getIconPath(i: IconPath | undefined): IconPath | undefined {
    if (i instanceof Uri) {
        return i.fsPath.endsWith('__icon__.py') ? undefined : i;
    }
    return i;
}

export class TerminalManager implements Disposable {
    private disposables: Disposable[] = [];
    private onTerminalOpenedEmitter = new EventEmitter<Terminal>();
    private onTerminalOpened = this.onTerminalOpenedEmitter.event;

    private onTerminalClosedEmitter = new EventEmitter<Terminal>();
    private onTerminalClosed = this.onTerminalClosedEmitter.event;

    private onTerminalShellIntegrationChangedEmitter = new EventEmitter<TerminalShellIntegrationChangeEvent>();
    private onTerminalShellIntegrationChanged = this.onTerminalShellIntegrationChangedEmitter.event;

    private onTerminalShellExecutionStartEmitter = new EventEmitter<TerminalShellExecutionStartEvent>();
    private onTerminalShellExecutionStart = this.onTerminalShellExecutionStartEmitter.event;

    private onTerminalShellExecutionEndEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();
    private onTerminalShellExecutionEnd = this.onTerminalShellExecutionEndEmitter.event;

    constructor() {
        this.disposables.push(
            onDidOpenTerminal((t: Terminal) => {
                this.onTerminalOpenedEmitter.fire(t);
            }),
            onDidCloseTerminal((t: Terminal) => {
                this.onTerminalClosedEmitter.fire(t);
            }),
            onDidChangeTerminalShellIntegration((e: TerminalShellIntegrationChangeEvent) => {
                this.onTerminalShellIntegrationChangedEmitter.fire(e);
            }),
            onDidStartTerminalShellExecution((e: TerminalShellExecutionStartEvent) => {
                this.onTerminalShellExecutionStartEmitter.fire(e);
            }),
            onDidEndTerminalShellExecution((e: TerminalShellExecutionEndEvent) => {
                this.onTerminalShellExecutionEndEmitter.fire(e);
            }),
            this.onTerminalOpenedEmitter,
            this.onTerminalClosedEmitter,
            this.onTerminalShellIntegrationChangedEmitter,
            this.onTerminalShellExecutionStartEmitter,
            this.onTerminalShellExecutionEndEmitter,
        );
    }

    private async activateUsingShellIntegration(
        terminal: Terminal,
        environment: PythonEnvironment,
        progress: Progress<{
            message?: string;
            increment?: number;
        }>,
    ): Promise<void> {}

    private async activateEnvironmentOnCreation(
        terminal: Terminal,
        environment: PythonEnvironment,
        progress: Progress<{
            message?: string;
            increment?: number;
        }>,
    ): Promise<void> {
        const deferred = createDeferred<void>();
        const disposables: Disposable[] = [];
        let disposeTimer: Disposable | undefined;
        let activated = false;

        try {
            disposables.push(
                this.onTerminalOpened(async (t: Terminal) => {
                    if (t === terminal) {
                        if (terminal.shellIntegration && !activated) {
                            await this.activateUsingShellIntegration(terminal, environment, progress);
                            deferred.resolve();
                        } else {
                            const timer = setInterval(() => {});
                        }
                    }
                }),
            );
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    }

    public async create(
        environment: PythonEnvironment,
        cwd?: string | Uri,
        env?: { [key: string]: string | null | undefined },
    ): Promise<Terminal> {
        const activatable = isActivatableEnvironment(environment);
        const newTerminal = createTerminal({
            // name: `Python: ${environment.displayName}`,
            iconPath: getIconPath(environment.iconPath),
            cwd,
            env,
        });
        if (activatable) {
            try {
                await withProgress(
                    {
                        location: ProgressLocation.Window,
                        title: `Activating ${environment.displayName}`,
                    },
                    async (progress) => {
                        await activateEnvironmentOnCreation(newTerminal, environment, progress);
                    },
                );
            } catch (e) {
                showErrorMessage(`Failed to activate ${environment.displayName}`);
            }
        }
        return newTerminal;
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
