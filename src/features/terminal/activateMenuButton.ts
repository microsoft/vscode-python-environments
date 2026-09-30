import { Terminal } from 'vscode';
import { PythonEnvironment } from '../../api';
import { isActivatableEnvironment } from '../common/activation';
import { executeCommand } from '../../common/command.api';
import { isTaskTerminal } from './utils';

export async function setActivateMenuButtonContext(
    terminal: Terminal,
    env: PythonEnvironment | undefined,
    activated?: boolean,
): Promise<void> {
    const activatable = !!env && !isTaskTerminal(terminal) && isActivatableEnvironment(env);
    await executeCommand('setContext', 'pythonTerminalActivation', activatable);

    if (!env || activated !== undefined) {
        await executeCommand('setContext', 'pythonTerminalActivated', env ? activated : false);
    }
}
