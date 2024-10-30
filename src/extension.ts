import { window, commands, ExtensionContext, LogOutputChannel, TextEditor } from 'vscode';

import { PythonEnvironmentManagers } from './features/envManagers';
import { registerLogger } from './common/logging';
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
import { isPythonProjectFile } from './common/utils/fileNameUtils';
import { createNativePythonFinder, NativePythonFinder } from './managers/common/nativePythonFinder';
import { PythonEnvironmentApi, PythonProject } from './api';
import {
    ProjectCreatorsImpl,
    registerAutoProjectProvider,
    registerExistingProjectProvider,
} from './features/projectCreators';
import { WorkspaceView } from './features/views/projectView';
import { registerCompletionProvider } from './features/settings/settingCompletions';
import { TerminalManager, TerminalManagerImpl } from './features/execution/terminalManager';

export async function activate(context: ExtensionContext): Promise<PythonEnvironmentApi> {
    // Logging should be set up before anything else.
    const outputChannel: LogOutputChannel = window.createOutputChannel('Python Environments', { log: true });
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));

    // Setup the persistent state for the extension.
    setPersistentState(context);

    const terminalManager: TerminalManager = new TerminalManagerImpl();

    const projectManager: PythonProjectManager = new PythonProjectManagerImpl();
    context.subscriptions.push(projectManager);

    const envManagers: EnvironmentManagers = new PythonEnvironmentManagers(projectManager);
    context.subscriptions.push(envManagers);

    const projectCreators: ProjectCreators = new ProjectCreatorsImpl();
    context.subscriptions.push(
        projectCreators,
        registerExistingProjectProvider(projectCreators),
        registerAutoProjectProvider(projectCreators),
    );

    setPythonApi(envManagers, projectManager, projectCreators);

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
            await createEnvironmentCommand(item, envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.createAny', async () => {
            await createAnyEnvironmentCommand(envManagers, projectManager);
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
            const result = await setEnvironmentCommand(item, envManagers, projectManager);
            if (result) {
                const projects: PythonProject[] = [];
                result.forEach((r) => {
                    if (r.projects) {
                        projects.push(r.projects);
                    }
                });
                workspaceView.updateProject(projects);
            }
        }),
        commands.registerCommand('python-envs.setEnv', async (item) => {
            const result = await setEnvironmentCommand(item, envManagers, projectManager);
            if (result) {
                const projects: PythonProject[] = [];
                result.forEach((r) => {
                    if (r.projects) {
                        projects.push(r.projects);
                    }
                });
                workspaceView.updateProject(projects);
            }
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
        window.onDidChangeActiveTextEditor(async (e: TextEditor | undefined) => {
            if (e && !e.document.isUntitled && e.document.uri.scheme === 'file') {
                if (
                    e.document.languageId === 'python' ||
                    e.document.languageId === 'pip-requirements' ||
                    isPythonProjectFile(e.document.uri.fsPath)
                ) {
                    const env = await workspaceView.reveal(e.document.uri);
                    await managerView.reveal(env);
                }
            }
        }),
        envManagers.onDidChangeEnvironment(async (e) => {
            const activeDocument = window.activeTextEditor?.document;
            if (!activeDocument || activeDocument.isUntitled || activeDocument.uri.scheme !== 'file') {
                return;
            }

            if (
                activeDocument.languageId !== 'python' &&
                activeDocument.languageId !== 'pip-requirements' &&
                !isPythonProjectFile(activeDocument.uri.fsPath)
            ) {
                return;
            }

            const mgr1 = envManagers.getEnvironmentManager(e.uri);
            const mgr2 = envManagers.getEnvironmentManager(activeDocument.uri);
            if (mgr1 === mgr2 && e.new) {
                const env = await workspaceView.reveal(activeDocument.uri);
                await managerView.reveal(env);
            }
        }),
    );

    /**
     * Below are all the contributed features using the APIs.
     */

    // This is the finder that is used by all the built in environment managers
    const nativeFinder: NativePythonFinder = createNativePythonFinder(outputChannel, api, context);
    context.subscriptions.push(nativeFinder);

    setImmediate(async () => {
        await Promise.all([
            registerSystemPythonFeatures(nativeFinder, context.subscriptions, outputChannel),
            registerCondaFeatures(nativeFinder, context.subscriptions, outputChannel),
        ]);
    });

    return api;
}

export function deactivate() {}
