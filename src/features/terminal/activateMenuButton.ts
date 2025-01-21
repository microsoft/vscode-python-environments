import { Terminal, TerminalOptions, Uri } from 'vscode';
import { activeTerminal } from '../../common/window.apis';
import { TerminalActivation, TerminalEnvironment } from './terminalManager';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { PythonEnvironment } from '../../api';
import { isActivatableEnvironment } from '../common/activation';
import { executeCommand } from '../../common/command.api';
import { getWorkspaceFolders } from '../../common/workspace.apis';
import { isTaskTerminal } from './utils';

async function getDistinctProjectEnvs(pm: PythonProjectManager, em: EnvironmentManagers): Promise<PythonEnvironment[]> {
    const projects = pm.getProjects();
    const envs: PythonEnvironment[] = [];
    const projectEnvs = await Promise.all(
        projects.map(async (p) => {
            const manager = em.getEnvironmentManager(p.uri);
            return manager?.get(p.uri);
        }),
    );
    projectEnvs.forEach((e) => {
        if (e && !envs.find((x) => x.envId.id === e.envId.id)) {
            envs.push(e);
        }
    });
    return envs;
}

export async function getEnvironmentForTerminal(
    tm: TerminalEnvironment,
    pm: PythonProjectManager,
    em: EnvironmentManagers,
    t: Terminal,
): Promise<PythonEnvironment | undefined> {
    let env = await tm.getEnvironment(t);
    if (env) {
        return env;
    }

    const projects = pm.getProjects();
    if (projects.length === 0) {
        const manager = em.getEnvironmentManager(undefined);
        env = await manager?.get(undefined);
    } else if (projects.length === 1) {
        const manager = em.getEnvironmentManager(projects[0].uri);
        env = await manager?.get(projects[0].uri);
    } else {
        const envs = await getDistinctProjectEnvs(pm, em);
        if (envs.length === 1) {
            // If we have only one distinct environment, then use that.
            env = envs[0];
        } else {
            // If we have multiple distinct environments, then we can't pick one
            // So skip selecting so we can try heuristic approach
        }
    }
    if (env) {
        return env;
    }

    // This is a heuristic approach to attempt to find the environment for this terminal.
    // This is not guaranteed to work, but is better than nothing.
    let tempCwd = t.shellIntegration?.cwd ?? (t.creationOptions as TerminalOptions)?.cwd;
    let cwd = typeof tempCwd === 'string' ? Uri.file(tempCwd) : tempCwd;
    if (cwd) {
        const manager = em.getEnvironmentManager(cwd);
        env = await manager?.get(cwd);
    } else {
        const workspaces = getWorkspaceFolders() ?? [];
        if (workspaces.length === 1) {
            const manager = em.getEnvironmentManager(workspaces[0].uri);
            env = await manager?.get(workspaces[0].uri);
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
    const activatable = !isTaskTerminal(terminal) && isActivatableEnvironment(env);
    await executeCommand('setContext', 'pythonTerminalActivation', activatable);

    if (!activatable) {
        return;
    }

    if (tm.isActivated(terminal)) {
        await executeCommand('setContext', 'pythonTerminalActivated', true);
    } else {
        await executeCommand('setContext', 'pythonTerminalActivated', false);
    }
}
