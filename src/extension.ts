import { commands, ExtensionContext, LogOutputChannel, Terminal, Uri, window } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProjectCreator } from './api';
import { ensureCorrectVersion } from './common/extVersion';
import { registerTools } from './common/lm.apis';
import { registerLogger, traceError, traceInfo } from './common/logging';
import { setPersistentState } from './common/persistentState';
import { newProjectSelection } from './common/pickers/managers';
import { StopWatch } from './common/stopWatch';
import { EventNames } from './common/telemetry/constants';
import { sendManagerSelectionTelemetry } from './common/telemetry/helpers';
import { sendTelemetryEvent } from './common/telemetry/sender';
import {
    activeTerminal,
    createLogOutputChannel,
    onDidChangeActiveTerminal,
    onDidChangeTerminalShellIntegration,
} from './common/window.apis';
import { createManagerReady } from './features/common/managerReady';
import { AutoFindProjects } from './features/creators/autoFindProjects';
import { ExistingProjects } from './features/creators/existingProjects';
import { NewPackageProject } from './features/creators/newPackageProject';
import { NewScriptProject } from './features/creators/newScriptProject';
import { ProjectCreatorsImpl } from './features/creators/projectCreators';
import {
    addPythonProjectCommand,
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
import { normalizeShellPath } from './features/terminal/shells/common/shellUtils';
import {
    clearShellProfileCache,
    createShellEnvProviders,
    createShellStartupProviders,
} from './features/terminal/shells/providers';
import { ShellStartupActivationVariablesManagerImpl } from './features/terminal/shellStartupActivationVariablesManager';
import { cleanupStartupScripts } from './features/terminal/shellStartupSetupHandlers';
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
import { registerPoetryFeatures } from './managers/poetry/main';
import { registerPyenvFeatures } from './managers/pyenv/main';
import { GetEnvironmentInfoTool } from './features/chat/getEnvInfoTool';
import { GetExecutableTool } from './features/chat/getExecutableTool';
import { InstallPackageTool } from './features/chat/installPackagesTool';
import { CreateQuickVirtualEnvironmentTool } from './features/chat/createQuickVenvTool';
import { createDeferred } from './common/utils/deferred';
import { SysPythonManager } from './managers/builtin/sysPythonManager';

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

    // Helper function to check if a resource is an existing Python project
    const isExistingProject = (uri: Uri | undefined): boolean => {
        if (!uri) {
            return false;
        }
        return projectManager.get(uri) !== undefined;
    };

    const envVarManager: EnvVarManager = new PythonEnvVariableManager(projectManager);
    context.subscriptions.push(envVarManager);

    const envManagers: EnvironmentManagers = new PythonEnvironmentManagers(projectManager);
    createManagerReady(envManagers, projectManager, context.subscriptions);
    context.subscriptions.push(envManagers);

    const terminalActivation = new TerminalActivationImpl();
    const shellEnvsProviders = createShellEnvProviders();
    const shellStartupProviders = createShellStartupProviders();

    const terminalManager: TerminalManager = new TerminalManagerImpl(
        terminalActivation,
        shellEnvsProviders,
        shellStartupProviders,
    );
    context.subscriptions.push(terminalActivation, terminalManager);

    const projectCreators: ProjectCreators = new ProjectCreatorsImpl();
    context.subscriptions.push(
        projectCreators,
        projectCreators.registerPythonProjectCreator(new ExistingProjects(projectManager)),
        projectCreators.registerPythonProjectCreator(new AutoFindProjects(projectManager)),
        projectCreators.registerPythonProjectCreator(new NewPackageProject(envManagers, projectManager)),
        projectCreators.registerPythonProjectCreator(new NewScriptProject()),
    );

    setPythonApi(envManagers, projectManager, projectCreators, terminalManager, envVarManager);
    const api = await getPythonApi();
    const sysPythonManager = createDeferred<SysPythonManager>();
    const managerView = new EnvManagerView(envManagers);
    context.subscriptions.push(managerView);

    const workspaceView = new ProjectView(envManagers, projectManager);
    context.subscriptions.push(workspaceView);
    workspaceView.initialize();

    const monitoredTerminals = new Map<Terminal, PythonEnvironment>();
    const shellStartupVarsMgr = new ShellStartupActivationVariablesManagerImpl(
        context.environmentVariableCollection,
        shellEnvsProviders,
        api,
    );

    context.subscriptions.push(
        shellStartupVarsMgr,
        registerCompletionProvider(envManagers),
        registerTools(
            CreateQuickVirtualEnvironmentTool.toolName,
            new CreateQuickVirtualEnvironmentTool(
                api,
                envManagers,
                projectManager,
                sysPythonManager.promise,
                outputChannel,
            ),
        ),
        registerTools(GetEnvironmentInfoTool.toolName, new GetEnvironmentInfoTool(api, envManagers)),
        registerTools(GetExecutableTool.toolName, new GetExecutableTool(api, envManagers)),
        registerTools(InstallPackageTool.toolName, new InstallPackageTool(api)),
        commands.registerCommand('python-envs.terminal.revertStartupScriptChanges', async () => {
            await cleanupStartupScripts(shellStartupProviders);
        }),
        commands.registerCommand('python-envs.viewLogs', () => outputChannel.show()),
        commands.registerCommand('python-envs.refreshManager', async (item) => {
            await refreshManagerCommand(item);
        }),
        commands.registerCommand('python-envs.refreshAllManagers', async () => {
            await Promise.all(envManagers.managers.map((m) => m.refresh(undefined)));
        }),
        commands.registerCommand('python-envs.refreshPackages', async (item) => {
            await refreshPackagesCommand(item, envManagers);
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
            try {
                packageManager.manage(environment, { install: [] });
            } catch (err) {
                traceError('Error when running command python-envs.packages', err);
            }
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
            // Set context to show/hide menu item depending on whether the resource is already a Python project
            if (resource instanceof Uri) {
                commands.executeCommand('setContext', 'python-envs:isExistingProject', isExistingProject(resource));
            }
            await addPythonProjectCommand(resource, projectManager, envManagers, projectCreators);
        }),
        commands.registerCommand('python-envs.removePythonProject', async (item) => {
            await resetEnvironmentCommand(item, envManagers, projectManager);
            await removePythonProject(item, projectManager);
        }),
        commands.registerCommand('python-envs.clearCache', async () => {
            await envManagers.clearCache(undefined);
            await clearShellProfileCache(shellStartupProviders);
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
        commands.registerCommand(
            'python-envs.createNewProjectFromTemplate',
            async (projectType: string, quickCreate: boolean, newProjectName: string, newProjectPath: string) => {
                if (quickCreate) {
                    if (!projectType || !newProjectName || !newProjectPath) {
                        throw new Error('Project type, name, and path are required for quick create.');
                    }
                    const creators = projectCreators.getProjectCreators();
                    let selected: PythonProjectCreator | undefined;
                    if (projectType === 'python-package') {
                        selected = creators.find((c) => c.name === 'newPackage');
                    }
                    if (projectType === 'python-script') {
                        selected = creators.find((c) => c.name === 'newScript');
                    }
                    if (!selected) {
                        throw new Error(`Project creator for type "${projectType}" not found.`);
                    }
                    await selected.create({
                        quickCreate: true,
                        name: newProjectName,
                        rootUri: Uri.file(newProjectPath),
                    });
                } else {
                    const selected = await newProjectSelection(projectCreators.getProjectCreators());
                    if (selected) {
                        await selected.create();
                    }
                }
            },
        ),
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
        window.onDidChangeActiveTextEditor(async () => {
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
        const sysMgr = new SysPythonManager(nativeFinder, api, outputChannel);
        sysPythonManager.resolve(sysMgr);
        await Promise.all([
            registerSystemPythonFeatures(nativeFinder, context.subscriptions, outputChannel, sysMgr),
            registerCondaFeatures(nativeFinder, context.subscriptions, outputChannel),
            registerPyenvFeatures(nativeFinder, context.subscriptions),
            registerPoetryFeatures(nativeFinder, context.subscriptions, outputChannel),
            shellStartupVarsMgr.initialize(),
        ]);

        sendTelemetryEvent(EventNames.EXTENSION_MANAGER_REGISTRATION_DURATION, start.elapsedTime);
        await terminalManager.initialize(api);
        sendManagerSelectionTelemetry(projectManager);
    });

    sendTelemetryEvent(EventNames.EXTENSION_ACTIVATION_DURATION, start.elapsedTime);

    return api;
}

export function deactivate() {}
