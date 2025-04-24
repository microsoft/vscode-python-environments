import * as path from 'path';
import { Terminal, TerminalOptions, Uri } from 'vscode';
import { PythonEnvironment, PythonProject, PythonProjectEnvironmentApi, PythonProjectGetterApi } from '../../api';
import { sleep } from '../../common/utils/asyncUtils';
import { getConfiguration, getWorkspaceFolders } from '../../common/workspace.apis';

const SHELL_INTEGRATION_TIMEOUT = 500; // 0.5 seconds
const SHELL_INTEGRATION_POLL_INTERVAL = 20; // 0.02 seconds

export async function waitForShellIntegration(terminal: Terminal): Promise<boolean> {
    let timeout = 0;
    while (!terminal.shellIntegration && timeout < SHELL_INTEGRATION_TIMEOUT) {
        await sleep(SHELL_INTEGRATION_POLL_INTERVAL);
        timeout += SHELL_INTEGRATION_POLL_INTERVAL;
    }
    return terminal.shellIntegration !== undefined;
}

export function isTaskTerminal(terminal: Terminal): boolean {
    // TODO: Need API for core for this https://github.com/microsoft/vscode/issues/234440
    return terminal.name.toLowerCase().includes('task');
}

export function getTerminalCwd(terminal: Terminal): string | undefined {
    if (terminal.shellIntegration?.cwd) {
        return terminal.shellIntegration.cwd.fsPath;
    }
    const cwd = (terminal.creationOptions as TerminalOptions)?.cwd;
    if (cwd) {
        return typeof cwd === 'string' ? cwd : cwd.fsPath;
    }
    return undefined;
}

async function getDistinctProjectEnvs(
    api: PythonProjectEnvironmentApi,
    projects: readonly PythonProject[],
): Promise<PythonEnvironment[]> {
    const envs: PythonEnvironment[] = [];
    await Promise.all(
        projects.map(async (p) => {
            const e = await api.getEnvironment(p.uri);
            if (e && !envs.find((x) => x.envId.id === e.envId.id)) {
                envs.push(e);
            }
        }),
    );
    return envs;
}

export async function getEnvironmentForTerminal(
    api: PythonProjectGetterApi & PythonProjectEnvironmentApi,
    terminal?: Terminal,
): Promise<PythonEnvironment | undefined> {
    let env: PythonEnvironment | undefined;

    const projects = api.getPythonProjects();
    if (projects.length === 0) {
        env = await api.getEnvironment(undefined);
    } else if (projects.length === 1) {
        env = await api.getEnvironment(projects[0].uri);
    } else {
        const envs = await getDistinctProjectEnvs(api, projects);
        if (envs.length === 1) {
            // If we have only one distinct environment, then use that.
            env = envs[0];
        } else {
            // If we have multiple distinct environments, then we can't pick one
            // So skip selecting so we can try heuristic approach
            env = undefined;
        }
    }

    if (env) {
        return env;
    }

    // This is a heuristic approach to attempt to find the environment for this terminal.
    // This is not guaranteed to work, but is better than nothing.
    const terminalCwd = terminal ? getTerminalCwd(terminal) : undefined;
    if (terminalCwd) {
        env = await api.getEnvironment(Uri.file(path.resolve(terminalCwd)));
    } else {
        const workspaces = getWorkspaceFolders() ?? [];
        if (workspaces.length === 1) {
            env = await api.getEnvironment(workspaces[0].uri);
        }
    }

    return env;
}

export type AutoActivationType = 'off' | 'command' | 'shellStartup';
export function getAutoActivationType(): AutoActivationType {
    // 'startup' auto-activation means terminal is activated via shell startup scripts.
    // 'command' auto-activation means terminal is activated via a command.
    // 'off' means no auto-activation.
    const config = getConfiguration('python-envs');
    return config.get<AutoActivationType>('terminal.autoActivationType', 'command');
}

export async function setAutoActivationType(value: AutoActivationType): Promise<void> {
    const config = getConfiguration('python-envs');
    return await config.update('terminal.autoActivationType', value, true);
}

export async function getAllDistinctProjectEnvironments(
    api: PythonProjectGetterApi & PythonProjectEnvironmentApi,
): Promise<PythonEnvironment[] | undefined> {
    const envs: PythonEnvironment[] | undefined = [];

    const projects = api.getPythonProjects();
    if (projects.length === 0) {
        const env = await api.getEnvironment(undefined);
        if (env) {
            envs.push(env);
        }
    } else if (projects.length === 1) {
        const env = await api.getEnvironment(projects[0].uri);
        if (env) {
            envs.push(env);
        }
    } else {
        envs.push(...(await getDistinctProjectEnvs(api, projects)));
    }

    return envs.length > 0 ? envs : undefined;
}
