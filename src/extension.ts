import { commands, ExtensionContext, LogOutputChannel } from 'vscode';

import { PythonEnvironmentManagers } from './features/envManagers';
import { registerLogger, traceInfo } from './common/logging';
import { EnvManagerView } from './features/views/envManagersView';
import {
    addPythonProject,
    createEnvironmentCommand,
    createTerminalCommand,
    getPackageCommandOptions,
    handlePackagesCommand,
    refreshManagerCommand,
    removeEnvironmentCommand,
    removePythonProject,
    runAsTaskCommand,
    runInTerminalCommand,
    setEnvManagerCommand,
    setEnvironmentCommand,
    setPackageManagerCommand,
    resetEnvironmentCommand,
    refreshPackagesCommand,
    createAnyEnvironmentCommand,
    runInDedicatedTerminalCommand,
} from './features/envCommands';
import { registerCondaFeatures } from './managers/conda/main';
import { registerSystemPythonFeatures } from './managers/sysPython/main';
import { PythonProjectManagerImpl } from './features/projectManager';
import { EnvironmentManagers, ProjectCreators, PythonProjectManager } from './internal.api';
import { getPythonApi, setPythonApi } from './features/pythonApi';
import { setPersistentState } from './common/persistentState';
import { createNativePythonFinder, NativePythonFinder } from './managers/common/nativePythonFinder';
import { PythonEnvironmentApi } from './api';
import {
    ProjectCreatorsImpl,
    registerAutoProjectProvider,
    registerExistingProjectProvider,
} from './features/projectCreators';
import { WorkspaceView } from './features/views/projectView';
import { registerCompletionProvider } from './features/settings/settingCompletions';
import { TerminalManager, TerminalManagerImpl } from './features/terminal/terminalManager';
import {
    activeTerminal,
    createLogOutputChannel,
    onDidChangeActiveTerminal,
    onDidChangeActiveTextEditor,
} from './common/window.apis';
import {
    getEnvironmentForTerminal,
    setActivateMenuButtonContext,
    updateActivateMenuButtonContext,
} from './features/terminal/activateMenuButton';
import { PythonStatusBarImpl } from './features/views/pythonStatusBar';
import { updateViewsAndStatus } from './features/views/revealHandler';
import { EnvVarManager, PythonEnvVariableManager } from './features/execution/envVariableManager';

export async function activate(context: ExtensionContext): Promise<PythonEnvironmentApi> {
    // Logging should be set up before anything else.
    const outputChannel: LogOutputChannel = createLogOutputChannel('Python Environments');
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));

    // Setup the persistent state for the extension.
    setPersistentState(context);

    const statusBar = new PythonStatusBarImpl();
    context.subscriptions.push(statusBar);

    const terminalManager: TerminalManager = new TerminalManagerImpl();
    context.subscriptions.push(terminalManager);

    const projectManager: PythonProjectManager = new PythonProjectManagerImpl();
    context.subscriptions.push(projectManager);

    const envVarManager: EnvVarManager = new PythonEnvVariableManager(projectManager);
    context.subscriptions.push(envVarManager);

    const envManagers: EnvironmentManagers = new PythonEnvironmentManagers(projectManager);
    context.subscriptions.push(envManagers);

    const projectCreators: ProjectCreators = new ProjectCreatorsImpl();
    context.subscriptions.push(
        projectCreators,
        registerExistingProjectProvider(projectCreators),
        registerAutoProjectProvider(projectCreators),
    );

    setPythonApi(envManagers, projectManager, projectCreators, terminalManager, envVarManager);

    const managerView = new EnvManagerView(envManagers);
    context.subscriptions.push(managerView);

    const workspaceView = new WorkspaceView(envManagers, projectManager);
    context.subscriptions.push(workspaceView);

    workspaceView.initialize();
    const api = await getPythonApi();

    context.subscriptions.push(
        registerCompletionProvider(envManagers),
        commands.registerCommand('python-envs.viewLogs', () => outputChannel.show()),
        commands.registerCommand('python-envs.refreshManager', async (item) => {
            await refreshManagerCommand(item);
        }),
        commands.registerCommand('python-envs.refreshAllManagers', async () => {
            await Promise.all(envManagers.managers.map((m) => m.refresh(undefined)));
        }),
        commands.registerCommand('python-envs.refreshPackages', async (item) => {
            await refreshPackagesCommand(item);
        }),
        commands.registerCommand('python-envs.create', async (item) => {
            return await createEnvironmentCommand(item, envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.createAny', async (options) => {
            return await createAnyEnvironmentCommand(
                envManagers,
                projectManager,
                options ?? { selectEnvironment: true },
            );
        }),
        commands.registerCommand('python-envs.remove', async (item) => {
            await removeEnvironmentCommand(item, envManagers);
        }),
        commands.registerCommand('python-envs.packages', async (options: unknown) => {
            const { environment, packageManager } = await getPackageCommandOptions(
                options,
                envManagers,
                projectManager,
            );
            await handlePackagesCommand(packageManager, environment);
        }),
        commands.registerCommand('python-envs.set', async (item) => {
            await setEnvironmentCommand(item, envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.setEnv', async (item) => {
            await setEnvironmentCommand(item, envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.reset', async (item) => {
            await resetEnvironmentCommand(item, envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.setEnvManager', async () => {
            await setEnvManagerCommand(envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.setPkgManager', async () => {
            await setPackageManagerCommand(envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.addPythonProject', async (resource) => {
            await addPythonProject(resource, projectManager, envManagers, projectCreators);
        }),
        commands.registerCommand('python-envs.removePythonProject', async (item) => {
            await resetEnvironmentCommand(item, envManagers, projectManager);
            await removePythonProject(item, projectManager);
        }),
        commands.registerCommand('python-envs.clearCache', async () => {
            await envManagers.clearCache(undefined);
        }),
        commands.registerCommand('python-envs.runInTerminal', (item) => {
            return runInTerminalCommand(item, api, terminalManager);
        }),
        commands.registerCommand('python-envs.runInDedicatedTerminal', (item) => {
            return runInDedicatedTerminalCommand(item, api, terminalManager);
        }),
        commands.registerCommand('python-envs.runAsTask', (item) => {
            return runAsTaskCommand(item, api);
        }),
        commands.registerCommand('python-envs.createTerminal', (item) => {
            return createTerminalCommand(item, api, terminalManager);
        }),
        commands.registerCommand('python-envs.terminal.activate', async () => {
            const terminal = activeTerminal();
            if (terminal) {
                const env = await getEnvironmentForTerminal(terminalManager, projectManager, envManagers, terminal);
                if (env) {
                    await terminalManager.activate(terminal, env);
                    await setActivateMenuButtonContext(terminalManager, terminal, env);
                }
            }
        }),
        commands.registerCommand('python-envs.terminal.deactivate', async () => {
            const terminal = activeTerminal();
            if (terminal) {
                await terminalManager.deactivate(terminal);
                const env = await getEnvironmentForTerminal(terminalManager, projectManager, envManagers, terminal);
                if (env) {
                    await setActivateMenuButtonContext(terminalManager, terminal, env);
                }
            }
        }),
        envManagers.onDidChangeEnvironmentManager(async () => {
            await updateActivateMenuButtonContext(terminalManager, projectManager, envManagers);
        }),
        onDidChangeActiveTerminal(async (t) => {
            await updateActivateMenuButtonContext(terminalManager, projectManager, envManagers, t);
        }),
        onDidChangeActiveTextEditor(async () => {
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        envManagers.onDidChangeEnvironment(async () => {
            await updateActivateMenuButtonContext(terminalManager, projectManager, envManagers);
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        envManagers.onDidChangeEnvironments(async () => {
            await updateActivateMenuButtonContext(terminalManager, projectManager, envManagers);
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        envManagers.onDidChangeEnvironmentFiltered(async (e) => {
            const location = e.uri?.fsPath ?? 'global';
            traceInfo(
                `Internal: Changed environment from ${e.old?.displayName} to ${e.new?.displayName} for: ${location}`,
            );
            await updateActivateMenuButtonContext(terminalManager, projectManager, envManagers);
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
    );

    /**
     * Below are all the contributed features using the APIs.
     */
    setImmediate(async () => {
        // This is the finder that is used by all the built in environment managers
        const nativeFinder: NativePythonFinder = await createNativePythonFinder(outputChannel, api, context);
        context.subscriptions.push(nativeFinder);
        await Promise.all([
            registerSystemPythonFeatures(nativeFinder, context.subscriptions, outputChannel),
            registerCondaFeatures(nativeFinder, context.subscriptions, outputChannel),
        ]);
    });

    return api;
}

export function deactivate() {}
