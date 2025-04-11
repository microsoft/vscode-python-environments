import { commands, ExtensionContext, LogOutputChannel, Terminal, Uri } from 'vscode';

import { PythonEnvironment, PythonEnvironmentApi } from './api';
import { ensureCorrectVersion } from './common/extVersion';
import { registerTools } from './common/lm.apis';
import { registerLogger, traceInfo } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { StopWatch } from './common/stopWatch';
import { EventNames } from './common/telemetry/constants';
import { sendTelemetryEvent } from './common/telemetry/sender';
import {
    activeTerminal,
    createLogOutputChannel,
    onDidChangeActiveTerminal,
    onDidChangeActiveTextEditor,
    onDidChangeTerminalShellIntegration,
} from './common/window.apis';
import { GetEnvironmentInfoTool, InstallPackageTool } from './features/copilotTools';
import { AutoFindProjects } from './features/creators/autoFindProjects';
import { ExistingProjects } from './features/creators/existingProjects';
import { ProjectCreatorsImpl } from './features/creators/projectCreators';
import {
    addPythonProject,
    copyPathToClipboard,
    createAnyEnvironmentCommand,
    createEnvironmentCommand,
    createTerminalCommand,
    getPackageCommandOptions,
    handlePackageUninstall,
    refreshManagerCommand,
    refreshPackagesCommand,
    removeEnvironmentCommand,
    removePythonProject,
    resetEnvironmentCommand,
    runAsTaskCommand,
    runInDedicatedTerminalCommand,
    runInTerminalCommand,
    setEnvironmentCommand,
    setEnvManagerCommand,
    setPackageManagerCommand,
} from './features/envCommands';
import { PythonEnvironmentManagers } from './features/envManagers';
import { EnvVarManager, PythonEnvVariableManager } from './features/execution/envVariableManager';
import { PythonProjectManagerImpl } from './features/projectManager';
import { getPythonApi, setPythonApi } from './features/pythonApi';
import { registerCompletionProvider } from './features/settings/settingCompletions';
import { setActivateMenuButtonContext } from './features/terminal/activateMenuButton';
import { ShellStartupActivationManagerImpl } from './features/terminal/shells/activateUsingShellStartup';
import { normalizeShellPath } from './features/terminal/shells/common/shellUtils';
import { createShellEnvProviders, createShellStartupProviders } from './features/terminal/shells/providers';
import { TerminalActivationImpl } from './features/terminal/terminalActivationState';
import { TerminalManager, TerminalManagerImpl } from './features/terminal/terminalManager';
import { getEnvironmentForTerminal } from './features/terminal/utils';
import { EnvManagerView } from './features/views/envManagersView';
import { ProjectView } from './features/views/projectView';
import { PythonStatusBarImpl } from './features/views/pythonStatusBar';
import { updateViewsAndStatus } from './features/views/revealHandler';
import { EnvironmentManagers, ProjectCreators, PythonProjectManager } from './internal.api';
import { registerSystemPythonFeatures } from './managers/builtin/main';
import { createNativePythonFinder, NativePythonFinder } from './managers/common/nativePythonFinder';
import { registerCondaFeatures } from './managers/conda/main';

export async function activate(context: ExtensionContext): Promise<PythonEnvironmentApi> {
    const start = new StopWatch();

    // Logging should be set up before anything else.
    const outputChannel: LogOutputChannel = createLogOutputChannel('Python Environments');
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));

    ensureCorrectVersion();

    // Setup the persistent state for the extension.
    setPersistentState(context);

    const statusBar = new PythonStatusBarImpl();
    context.subscriptions.push(statusBar);

    const projectManager: PythonProjectManager = new PythonProjectManagerImpl();
    context.subscriptions.push(projectManager);

    const envVarManager: EnvVarManager = new PythonEnvVariableManager(projectManager);
    context.subscriptions.push(envVarManager);

    const envManagers: EnvironmentManagers = new PythonEnvironmentManagers(projectManager);
    context.subscriptions.push(envManagers);

    const terminalActivation = new TerminalActivationImpl();
    const shellEnvsProviders = createShellEnvProviders();
    const shellStartupProviders = createShellStartupProviders();
    const shellStartupActivationManager = new ShellStartupActivationManagerImpl(
        context.environmentVariableCollection,
        shellStartupProviders,
        envManagers,
    );
    const terminalManager: TerminalManager = new TerminalManagerImpl(terminalActivation, shellEnvsProviders);
    context.subscriptions.push(terminalActivation, terminalManager, shellStartupActivationManager);

    const projectCreators: ProjectCreators = new ProjectCreatorsImpl();
    context.subscriptions.push(
        projectCreators,
        projectCreators.registerPythonProjectCreator(new ExistingProjects()),
        projectCreators.registerPythonProjectCreator(new AutoFindProjects(projectManager)),
    );

    setPythonApi(envManagers, projectManager, projectCreators, terminalManager, envVarManager);
    const api = await getPythonApi();

    const managerView = new EnvManagerView(envManagers);
    context.subscriptions.push(managerView);

    const workspaceView = new ProjectView(envManagers, projectManager);
    context.subscriptions.push(workspaceView);
    workspaceView.initialize();

    const monitoredTerminals = new Map<Terminal, PythonEnvironment>();

    context.subscriptions.push(
        registerCompletionProvider(envManagers),
        registerTools('python_environment_tool', new GetEnvironmentInfoTool(api, envManagers)),
        registerTools('python_install_package_tool', new InstallPackageTool(api)),
        commands.registerCommand('python-envs.terminal.revertStartupScriptChanges', async () => {
            await shellStartupActivationManager.cleanupStartupScripts();
        }),
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
            packageManager.manage(environment, { install: [] });
        }),
        commands.registerCommand('python-envs.uninstallPackage', async (context: unknown) => {
            await handlePackageUninstall(context, envManagers);
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
        commands.registerCommand('python-envs.copyEnvPath', async (item) => {
            await copyPathToClipboard(item);
        }),
        commands.registerCommand('python-envs.copyProjectPath', async (item) => {
            await copyPathToClipboard(item);
        }),
        commands.registerCommand('python-envs.terminal.activate', async () => {
            const terminal = activeTerminal();
            if (terminal) {
                const env = await getEnvironmentForTerminal(api, terminal);
                if (env) {
                    await terminalManager.activate(terminal, env);
                }
            }
        }),
        commands.registerCommand('python-envs.terminal.deactivate', async () => {
            const terminal = activeTerminal();
            if (terminal) {
                await terminalManager.deactivate(terminal);
            }
        }),
        terminalActivation.onDidChangeTerminalActivationState(async (e) => {
            await setActivateMenuButtonContext(e.terminal, e.environment, e.activated);
        }),
        onDidChangeActiveTerminal(async (t) => {
            if (t) {
                const env = terminalActivation.getEnvironment(t) ?? (await getEnvironmentForTerminal(api, t));
                if (env) {
                    await setActivateMenuButtonContext(t, env, terminalActivation.isActivated(t));
                }
            }
        }),
        onDidChangeActiveTextEditor(async () => {
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        envManagers.onDidChangeEnvironment(async () => {
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        envManagers.onDidChangeEnvironments(async () => {
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        envManagers.onDidChangeEnvironmentFiltered(async (e) => {
            managerView.environmentChanged(e);
            const location = e.uri?.fsPath ?? 'global';
            traceInfo(
                `Internal: Changed environment from ${e.old?.displayName} to ${e.new?.displayName} for: ${location}`,
            );
            updateViewsAndStatus(statusBar, workspaceView, managerView, api);
        }),
        onDidChangeTerminalShellIntegration(async (e) => {
            const shellEnv = e.shellIntegration?.env;
            if (!shellEnv) {
                return;
            }
            const envVar = shellEnv.value;
            if (envVar) {
                if (envVar['VIRTUAL_ENV']) {
                    const envPath = normalizeShellPath(envVar['VIRTUAL_ENV'], e.terminal.state.shell);
                    const env = await api.resolveEnvironment(Uri.file(envPath));
                    if (env) {
                        monitoredTerminals.set(e.terminal, env);
                        terminalActivation.updateActivationState(e.terminal, env, true);
                    }
                } else if (monitoredTerminals.has(e.terminal)) {
                    const env = monitoredTerminals.get(e.terminal);
                    if (env) {
                        terminalActivation.updateActivationState(e.terminal, env, false);
                    }
                }
            }
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
            shellStartupActivationManager.initialize(),
        ]);
        sendTelemetryEvent(EventNames.EXTENSION_MANAGER_REGISTRATION_DURATION, start.elapsedTime);
        await terminalManager.initialize(api);
    });

    sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, start.elapsedTime);

    return api;
}

export function deactivate() {}
