import { StatusBarAlignment, StatusBarItem, Terminal } from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import { activeTextEditor, createStatusBarItem, onDidChangeActiveTerminal } from '../../common/window.apis';
import { TerminalActivation } from './terminalManager';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { isActivatableEnvironment } from './activation';
import { PythonEnvironment } from '../../api';

export class ActivateStatusButton implements Disposable {
    private readonly statusBarItem: StatusBarItem;
    private disposables: Disposable[] = [];

    constructor(
        private readonly tm: TerminalActivation,
        private readonly em: EnvironmentManagers,
        private readonly pm: PythonProjectManager,
    ) {
        this.statusBarItem = createStatusBarItem('python-envs.terminal.activate', StatusBarAlignment.Right, 100);
        this.disposables.push(
            this.statusBarItem,
            onDidChangeActiveTerminal(async (terminal) => {
                await this.update(terminal);
            }),
        );
    }

    public dispose() {
        this.disposables.forEach((d) => d.dispose());
    }

    public async update(terminal?: Terminal) {
        if (!terminal) {
            this.statusBarItem.hide();
            return;
        }

        const projects = this.pm.getProjects();
        if (projects.length === 0) {
            this.statusBarItem.hide();
            return;
        }

        const projectUri = projects.length === 1 ? projects[0].uri : activeTextEditor()?.document.uri;
        if (!projectUri) {
            this.statusBarItem.hide();
            return;
        }

        const manager = this.em.getEnvironmentManager(projectUri);
        const env = await manager?.get(projectUri);
        if (env && isActivatableEnvironment(env)) {
            this.updateStatusBarItem(terminal, env);
        } else {
            this.statusBarItem.hide();
        }
    }

    private updateStatusBarItem(terminal: Terminal, env: PythonEnvironment) {
        if (this.tm.isActivated(terminal, env)) {
            this.statusBarItem.text = '$(terminal) Deactivate';
            this.statusBarItem.tooltip = 'Deactivate the terminal';
            this.statusBarItem.command = {
                command: 'python-envs.terminal.deactivate',
                title: 'Deactivate the terminal',
                arguments: [terminal, env],
            };
        } else {
            this.statusBarItem.text = '$(terminal) Activate';
            this.statusBarItem.tooltip = 'Activate the terminal';
            this.statusBarItem.command = {
                command: 'python-envs.terminal.activate',
                title: 'Activate the terminal',
                arguments: [terminal, env],
            };
        }
        this.statusBarItem.show();
    }
}
