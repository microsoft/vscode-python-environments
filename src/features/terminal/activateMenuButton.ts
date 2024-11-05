import { Terminal } from 'vscode';
import { activeTerminal } from '../../common/window.apis';
import { TerminalActivation, TerminalEnvironment } from './terminalManager';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { PythonEnvironment } from '../../api';
import { isActivatableEnvironment } from '../common/activation';
import { executeCommand } from '../../common/command.api';

export async function getEnvironmentForTerminal(
    tm: TerminalEnvironment,
    pm: PythonProjectManager,
    em: EnvironmentManagers,
    t: Terminal,
): Promise<PythonEnvironment | undefined> {
    let env = await tm.getEnvironment(t);

    if (!env) {
        const projects = pm.getProjects();
        if (projects.length === 0) {
            const manager = em.getEnvironmentManager(undefined);
            env = await manager?.get(undefined);
        } else if (projects.length === 1) {
            const manager = em.getEnvironmentManager(projects[0].uri);
            env = await manager?.get(projects[0].uri);
        }
    }

    return env;
}

export async function updateActivateMenuButtonContext(
    tm: TerminalEnvironment & TerminalActivation,
    pm: PythonProjectManager,
    em: EnvironmentManagers,
    terminal?: Terminal,
): Promise<void> {
    const selected = terminal ?? activeTerminal();

    if (!selected) {
        return;
    }

    const env = await getEnvironmentForTerminal(tm, pm, em, selected);
    if (!env) {
        return;
    }

    await setActivateMenuButtonContext(tm, selected, env);
}

export async function setActivateMenuButtonContext(
    tm: TerminalActivation,
    terminal: Terminal,
    env: PythonEnvironment,
): Promise<void> {
    const activatable = isActivatableEnvironment(env);
    await executeCommand('setContext', 'pythonTerminalActivation', activatable);

    if (tm.isActivated(terminal)) {
        await executeCommand('setContext', 'pythonTerminalActivated', true);
    } else {
        await executeCommand('setContext', 'pythonTerminalActivated', false);
    }
}
