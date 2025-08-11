import { commands, ExtensionContext, extensions, LogOutputChannel, Terminal, Uri, window, workspace } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProjectCreator } from './api';
import { ensureCorrectVersion } from './common/extVersion';
import { registerLogger, traceError, traceInfo, traceWarn } from './common/logging';
import { clearPersistentState, setPersistentState } from './common/persistentState';
import { newProjectSelection } from './common/pickers/managers';
import { StopWatch } from './common/stopWatch';
import { EventNames } from './common/telemetry/constants';
import { sendManagerSelectionTelemetry } from './common/telemetry/helpers';
import { sendTelemetryEvent } from './common/telemetry/sender';
import { createDeferred } from './common/utils/deferred';
import { isWindows } from './common/utils/platformUtils';
import {
    activeTerminal,
    createLogOutputChannel,
    createTerminal,
    onDidChangeActiveTerminal,
    onDidChangeTerminalShellIntegration,
} from './common/window.apis';
import { getConfiguration } from './common/workspace.apis';
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
    refreshPackagesCommand,
    removeEnvironmentCommand,
    removePythonProject,
    revealProjectInExplorer,
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
import { TerminalEnvVarInjector } from './features/terminal/terminalEnvVarInjector';
import { TerminalManager, TerminalManagerImpl } from './features/terminal/terminalManager';
import { getAutoActivationType, getEnvironmentForTerminal } from './features/terminal/utils';
import { EnvManagerView } from './features/views/envManagersView';
import { ProjectView } from './features/views/projectView';
import { PythonStatusBarImpl } from './features/views/pythonStatusBar';
import { updateViewsAndStatus } from './features/views/revealHandler';
import { ProjectItem } from './features/views/treeViewItems';
import { EnvironmentManagers, ProjectCreators, PythonProjectManager } from './internal.api';
import { registerSystemPythonFeatures } from './managers/builtin/main';
import { SysPythonManager } from './managers/builtin/sysPythonManager';
import {
    createNativePythonFinder,
    getNativePythonToolsPath,
    NativePythonFinder,
} from './managers/common/nativePythonFinder';
import { IDisposable } from './managers/common/types';
import { registerCondaFeatures } from './managers/conda/main';
import { registerPoetryFeatures } from './managers/poetry/main';
import { registerPyenvFeatures } from './managers/pyenv/main';

/**
 * Collects relevant Python environment information for issue reporting
 */
async function collectEnvironmentInfo(
    context: ExtensionContext,
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager,
): Promise<string> {
    const info: string[] = [];

    try {
        // Extension version
        const extensionVersion = context.extension?.packageJSON?.version || 'unknown';
        info.push(`Extension Version: ${extensionVersion}`);

        // Python extension version
        const pythonExtension = extensions.getExtension('ms-python.python');
        const pythonVersion = pythonExtension?.packageJSON?.version || 'not installed';
        info.push(`Python Extension Version: ${pythonVersion}`);

        // Environment managers
        const managers = envManagers.managers;
        info.push(`\nRegistered Environment Managers (${managers.length}):`);
        managers.forEach((manager) => {
            info.push(`  - ${manager.id} (${manager.displayName})`);
        });

        // Available environments
        const allEnvironments: PythonEnvironment[] = [];
        for (const manager of managers) {
            try {
                const envs = await manager.getEnvironments('all');
                allEnvironments.push(...envs);
            } catch (err) {
                info.push(`  Error getting environments from ${manager.id}: ${err}`);
            }
        }

        info.push(`\nTotal Available Environments: ${allEnvironments.length}`);
        if (allEnvironments.length > 0) {
            info.push('Environment Details:');
            allEnvironments.slice(0, 10).forEach((env, index) => {
                info.push(`  ${index + 1}. ${env.displayName} (${env.version}) - ${env.displayPath}`);
            });
            if (allEnvironments.length > 10) {
                info.push(`  ... and ${allEnvironments.length - 10} more environments`);
            }
        }

        // Python projects
        const projects = projectManager.getProjects();
        info.push(`\nPython Projects (${projects.length}):`);
        for (let index = 0; index < projects.length; index++) {
            const project = projects[index];
            info.push(`  ${index + 1}. ${project.uri.fsPath}`);
            try {
                const env = await envManagers.getEnvironment(project.uri);
                if (env) {
                    info.push(`     Environment: ${env.displayName}`);
                }
            } catch (err) {
                info.push(`     Error getting environment: ${err}`);
            }
        }

        // Current settings (non-sensitive)
        const config = workspace.getConfiguration('python-envs');
        const pyConfig = workspace.getConfiguration('python');
        info.push('\nExtension Settings:');
        info.push(`  Default Environment Manager: ${config.get('defaultEnvManager')}`);
        info.push(`  Default Package Manager: ${config.get('defaultPackageManager')}`);
        const pyenvAct = config.get('terminal.autoActivationType', undefined);
        const pythonAct = pyConfig.get('terminal.activateEnvironment', undefined);
        info.push(
            `Auto-activation is "${getAutoActivationType()}". Activation based on first 'py-env.terminal.autoActivationType' setting which is '${pyenvAct}' and 'python.terminal.activateEnvironment' if the first is undefined which is '${pythonAct}'.\n`,
        );
    } catch (err) {
        info.push(`\nError collecting environment information: ${err}`);
    }

    return info.join('\n');
}

export async function activate(context: ExtensionContext): Promise<PythonEnvironmentApi | undefined> {
    const useEnvironmentsExtension = getConfiguration('python').get<boolean>('useEnvironmentsExtension', true);
    traceInfo(`Experiment Status: useEnvironmentsExtension setting set to ${useEnvironmentsExtension}`);
    if (!useEnvironmentsExtension) {
        traceWarn(
            'The Python environments extension has been disabled via a setting. If you would like to opt into using the extension, please add the following to your user settings (note that updating this setting requires a window reload afterwards):\n\n"python.useEnvironmentsExtension": true',
        );
        await deactivate(context);
        return;
    }
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
        projectCreators.registerPythonProjectCreator(new NewScriptProject(projectManager)),
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

    // Initialize terminal environment variable injection
    const terminalEnvVarInjector = new TerminalEnvVarInjector(context.environmentVariableCollection, envVarManager);
    context.subscriptions.push(terminalEnvVarInjector);

    context.subscriptions.push(
        shellStartupVarsMgr,
        registerCompletionProvider(envManagers),
        commands.registerCommand('python-envs.terminal.revertStartupScriptChanges', async () => {
            await cleanupStartupScripts(shellStartupProviders);
        }),
        commands.registerCommand('python-envs.viewLogs', () => outputChannel.show()),
        commands.registerCommand('python-envs.refreshAllManagers', async () => {
            await Promise.all(envManagers.managers.map((m) => m.refresh(undefined)));
        }),
        commands.registerCommand('python-envs.refreshPackages', async (item) => {
            await refreshPackagesCommand(item, envManagers);
        }),
        commands.registerCommand('python-envs.create', async (item) => {
            // Telemetry: record environment creation attempt with selected manager
            let managerId = 'unknown';
            if (item && item.manager && item.manager.id) {
                managerId = item.manager.id;
            }
            sendTelemetryEvent(EventNames.CREATE_ENVIRONMENT, undefined, {
                manager: managerId,
                triggeredLocation: 'createSpecifiedCommand',
            });
            return await createEnvironmentCommand(item, envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.createAny', async (options) => {
            // Telemetry: record environment creation attempt with no specific manager
            sendTelemetryEvent(EventNames.CREATE_ENVIRONMENT, undefined, {
                manager: 'none',
                triggeredLocation: 'createAnyCommand',
            });
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
        commands.registerCommand('python-envs.setEnvManager', async () => {
            await setEnvManagerCommand(envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.setPkgManager', async () => {
            await setPackageManagerCommand(envManagers, projectManager);
        }),
        commands.registerCommand('python-envs.addPythonProject', async () => {
            await addPythonProjectCommand(undefined, projectManager, envManagers, projectCreators);
            const totalProjectCount = projectManager.getProjects().length + 1;
            sendTelemetryEvent(EventNames.ADD_PROJECT, undefined, {
                template: 'none',
                quickCreate: false,
                totalProjectCount,
                triggeredLocation: 'add',
            });
        }),
        commands.registerCommand('python-envs.addPythonProjectGivenResource', async (resource) => {
            // Set context to show/hide menu item depending on whether the resource is already a Python project
            if (resource instanceof Uri) {
                commands.executeCommand('setContext', 'python-envs:isExistingProject', isExistingProject(resource));
            }

            await addPythonProjectCommand(resource, projectManager, envManagers, projectCreators);
            const totalProjectCount = projectManager.getProjects().length + 1;
            sendTelemetryEvent(EventNames.ADD_PROJECT, undefined, {
                template: 'none',
                quickCreate: false,
                totalProjectCount,
                triggeredLocation: 'addGivenResource',
            });
        }),
        commands.registerCommand('python-envs.removePythonProject', async (item) => {
            // Clear environment association before removing project
            if (item instanceof ProjectItem) {
                const uri = item.project.uri;
                const manager = envManagers.getEnvironmentManager(uri);
                if (manager) {
                    manager.set(uri, undefined);
                } else {
                    traceError(`No environment manager found for ${uri.fsPath}`);
                }
            }
            await removePythonProject(item, projectManager);
        }),
        commands.registerCommand('python-envs.clearCache', async () => {
            await clearPersistentState();
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
        commands.registerCommand('python-envs.revealProjectInExplorer', async (item) => {
            await revealProjectInExplorer(item);
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
                let projectTemplateName = projectType || 'unknown';
                let triggeredLocation: 'templateCreate' = 'templateCreate';
                let totalProjectCount = projectManager.getProjects().length + 1;
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
                        projectTemplateName = selected.name || 'unknown';
                        await selected.create();
                    }
                }
                sendTelemetryEvent(EventNames.ADD_PROJECT, undefined, {
                    template: projectTemplateName,
                    quickCreate: quickCreate,
                    totalProjectCount,
                    triggeredLocation,
                });
            },
        ),
        commands.registerCommand('python-envs.reportIssue', async () => {
            try {
                const issueData = await collectEnvironmentInfo(context, envManagers, projectManager);

                await commands.executeCommand('workbench.action.openIssueReporter', {
                    extensionId: 'ms-python.vscode-python-envs',
                    issueTitle: '[Python Environments] ',
                    issueBody: `<!-- Please describe the issue you're experiencing -->\n\n<!-- The following information was automatically generated -->\n\n<details>\n<summary>Environment Information</summary>\n\n\`\`\`\n${issueData}\n\`\`\`\n\n</details>`,
                });
            } catch (error) {
                window.showErrorMessage(`Failed to open issue reporter: ${error}`);
            }
        }),
        commands.registerCommand('python-envs.runPetInTerminal', async () => {
            try {
                const petPath = await getNativePythonToolsPath();

                // Show quick pick menu for PET operation selection
                const selectedOption = await window.showQuickPick(
                    [
                        {
                            label: 'Find All Environments',
                            description: 'Finds all environments and reports them to the standard output',
                            detail: 'Runs: pet find --verbose',
                        },
                        {
                            label: 'Resolve Environment...',
                            description: 'Resolves & reports the details of the environment to the standard output',
                            detail: 'Runs: pet resolve <path>',
                        },
                    ],
                    {
                        placeHolder: 'Select a Python Environment Tool (PET) operation',
                        ignoreFocusOut: true,
                    },
                );

                if (!selectedOption) {
                    return; // User cancelled
                }

                const terminal = createTerminal({
                    name: 'Python Environment Tool (PET)',
                });
                terminal.show();

                if (selectedOption.label === 'Find All Environments') {
                    // Run pet find --verbose
                    terminal.sendText(`"${petPath}" find --verbose`, true);
                    traceInfo(`Running PET find command: ${petPath} find --verbose`);
                } else if (selectedOption.label === 'Resolve Environment...') {
                    // Show input box for path
                    const placeholder = isWindows() ? 'C:\\path\\to\\python\\executable' : '/path/to/python/executable';
                    const inputPath = await window.showInputBox({
                        prompt: 'Enter the path to the Python executable to resolve',
                        placeHolder: placeholder,
                        ignoreFocusOut: true,
                        validateInput: (value) => {
                            if (!value || value.trim().length === 0) {
                                return 'Please enter a valid path';
                            }
                            return null;
                        },
                    });

                    if (!inputPath) {
                        return; // User cancelled
                    }

                    // Run pet resolve with the provided path
                    terminal.sendText(`"${petPath}" resolve "${inputPath.trim()}"`, true);
                    traceInfo(`Running PET resolve command: ${petPath} resolve "${inputPath.trim()}"`);
                }
            } catch (error) {
                traceError('Error running PET in terminal', error);
                window.showErrorMessage(`Failed to run Python Environment Tool: ${error}`);
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

export async function disposeAll(disposables: IDisposable[]): Promise<void> {
    await Promise.all(
        disposables.map(async (d) => {
            try {
                return Promise.resolve(d.dispose());
            } catch (_err) {
                // do nothing
            }
            return Promise.resolve();
        }),
    );
}

export async function deactivate(context: ExtensionContext) {
    await disposeAll(context.subscriptions);
    context.subscriptions.length = 0; // Clear subscriptions to prevent memory leaks
    traceInfo('Python Environments extension deactivated.');
}
