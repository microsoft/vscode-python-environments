import { QuickInputButtons, TaskExecution, TaskRevealKind, Terminal, Uri } from 'vscode';
import {
    EnvironmentManagers,
    InternalEnvironmentManager,
    InternalPackageManager,
    ProjectCreators,
    PythonProjectManager,
} from '../internal.api';
import { traceError, traceInfo, traceVerbose } from '../common/logging';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject, PythonProjectCreator } from '../api';
import * as path from 'path';
import {
    setEnvironmentManager,
    setPackageManager,
    addPythonProjectSetting,
    removePythonProjectSetting,
    getDefaultEnvManagerSetting,
    getDefaultPkgManagerSetting,
    EditProjectSettings,
} from './settings/settingHelpers';

import { getAbsolutePath } from '../common/utils/fileNameUtils';
import { runAsTask } from './execution/runAsTask';
import {
    EnvManagerTreeItem,
    PackageRootTreeItem,
    PythonEnvTreeItem,
    ProjectItem,
    ProjectEnvironment,
    ProjectPackageRootTreeItem,
    GlobalProjectItem,
    EnvTreeItemKind,
    PackageTreeItem,
    ProjectPackage,
} from './views/treeViewItems';
import { Common } from '../common/localize';
import { pickEnvironment } from '../common/pickers/environments';
import { pickEnvironmentManager, pickPackageManager, pickCreator } from '../common/pickers/managers';
import { pickPackageOptions } from '../common/pickers/packages';
import { pickProject, pickProjectMany } from '../common/pickers/projects';
import { TerminalManager } from './terminal/terminalManager';
import { runInTerminal } from './terminal/runInTerminal';
import { quoteArgs } from './execution/execUtils';
import { showErrorMessage } from '../common/errors/utils';
import { activeTextEditor } from '../common/window.apis';
import { clipboardWriteText } from '../common/env.apis';

export async function refreshManagerCommand(context: unknown): Promise<void> {
    if (context instanceof EnvManagerTreeItem) {
        const manager = (context as EnvManagerTreeItem).manager;
        await manager.refresh(undefined);
    } else {
        traceVerbose(`Invalid context for refresh command: ${context}`);
    }
}

export async function refreshPackagesCommand(context: unknown) {
    if (context instanceof ProjectPackageRootTreeItem) {
        const view = context as ProjectPackageRootTreeItem;
        const manager = view.manager;
        await manager.refresh(view.environment);
    } else if (context instanceof PackageRootTreeItem) {
        const view = context as PackageRootTreeItem;
        const manager = view.manager;
        await manager.refresh(view.environment);
    } else {
        traceVerbose(`Invalid context for refresh command: ${context}`);
    }
}

export async function createEnvironmentCommand(
    context: unknown,
    em: EnvironmentManagers,
    pm: PythonProjectManager,
): Promise<PythonEnvironment | undefined> {
    if (context instanceof EnvManagerTreeItem) {
        const manager = (context as EnvManagerTreeItem).manager;
        const projects = pm.getProjects();
        if (projects.length === 0) {
            const env = await manager.create('global');
            if (env) {
                await em.setEnvironments('global', env);
            }
            return env;
        } else if (projects.length > 0) {
            const selected = await pickProjectMany(projects);
            if (selected) {
                const scope = selected.length === 0 ? 'global' : selected.map((p) => p.uri);
                const env = await manager.create(scope);
                if (env) {
                    await em.setEnvironments(scope, env);
                }
                return env;
            } else {
                traceInfo('No project selected or global condition met for environment creation');
            }
        }
    } else if (context instanceof Uri) {
        const manager = em.getEnvironmentManager(context as Uri);
        const project = pm.get(context as Uri);
        if (project) {
            return await manager?.create(project.uri);
        } else {
            traceError(`No project found for ${context}`);
        }
    } else {
        traceError(`Invalid context for create command: ${context}`);
    }
}

export async function createAnyEnvironmentCommand(
    em: EnvironmentManagers,
    pm: PythonProjectManager,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
): Promise<PythonEnvironment | undefined> {
    const select = options?.selectEnvironment;
    const projects = pm.getProjects();
    if (projects.length === 0) {
        const managerId = await pickEnvironmentManager(em.managers.filter((m) => m.supportsCreate));
        const manager = em.managers.find((m) => m.id === managerId);
        if (manager) {
            const env = await manager.create('global');
            if (select && env) {
                await manager.set(undefined, env);
            }
            return env;
        }
    } else if (projects.length > 0) {
        const selected = await pickProjectMany(projects);

        if (selected && selected.length > 0) {
            const defaultManagers: InternalEnvironmentManager[] = [];

            selected.forEach((p) => {
                const manager = em.getEnvironmentManager(p.uri);
                if (manager && manager.supportsCreate && !defaultManagers.includes(manager)) {
                    defaultManagers.push(manager);
                }
            });

            const managerId = await pickEnvironmentManager(
                em.managers.filter((m) => m.supportsCreate),
                defaultManagers,
            );

            const manager = em.managers.find((m) => m.id === managerId);
            if (manager) {
                const env = await manager.create(selected.map((p) => p.uri));
                if (select && env) {
                    await em.setEnvironments(
                        selected.map((p) => p.uri),
                        env,
                    );
                }
                return env;
            }
        }
    }
}

export async function removeEnvironmentCommand(context: unknown, managers: EnvironmentManagers): Promise<void> {
    if (context instanceof PythonEnvTreeItem) {
        const view = context as PythonEnvTreeItem;
        const manager =
            view.parent.kind === EnvTreeItemKind.environmentGroup ? view.parent.parent.manager : view.parent.manager;
        await manager.remove(view.environment);
    } else if (context instanceof Uri) {
        const manager = managers.getEnvironmentManager(context as Uri);
        const environment = await manager?.get(context as Uri);
        if (environment) {
            await manager?.remove(environment);
        }
    } else if (context instanceof ProjectEnvironment) {
        const view = context as ProjectEnvironment;
        const manager = managers.getEnvironmentManager(view.parent.project.uri);
        await manager?.remove(view.environment);
    } else {
        traceError(`Invalid context for remove command: ${context}`);
    }
}

export async function handlePackagesCommand(
    environment: PythonEnvironment,
    packageManager: InternalPackageManager,
): Promise<void> {
    const action = await pickPackageOptions();

    try {
        if (action === Common.install) {
            await packageManager.install(environment, undefined, { showSkipOption: false });
        } else if (action === Common.uninstall) {
            await packageManager.uninstall(environment);
        }
    } catch (ex) {
        if (ex === QuickInputButtons.Back) {
            return handlePackagesCommand(environment, packageManager);
        }
        throw ex;
    }
}

export function getUninstallPackages(context: unknown): string[] | undefined {
    if (context instanceof PackageTreeItem) {
        return [(context as PackageTreeItem).pkg.name];
    } else if (context instanceof ProjectPackage) {
        return [(context as ProjectPackage).pkg.name];
    }
    return undefined;
}

export async function handlePackageUninstall(context: unknown, em: EnvironmentManagers) {
    if (context instanceof PackageTreeItem || context instanceof ProjectPackage) {
        const moduleName = context.pkg.name;
        const environment = context.parent.environment;
        const packageManager = em.getPackageManager(environment);
        await packageManager?.uninstall(environment, [moduleName]);
        return;
    }
    traceError(`Invalid context for uninstall command: ${typeof context}`);
}

export async function setEnvironmentCommand(
    context: unknown,
    em: EnvironmentManagers,
    wm: PythonProjectManager,
): Promise<void> {
    if (context instanceof PythonEnvTreeItem) {
        try {
            const view = context as PythonEnvTreeItem;
            const projects = wm.getProjects();
            if (projects.length > 0) {
                const selected = await pickProjectMany(projects);
                if (selected && selected.length > 0) {
                    const uris = selected.map((p) => p.uri);
                    await em.setEnvironments(uris, view.environment);
                }
            } else {
                await em.setEnvironments('global', view.environment);
            }
        } catch (ex) {
            if (ex === QuickInputButtons.Back) {
                await setEnvironmentCommand(context, em, wm);
            }
            throw ex;
        }
    } else if (context instanceof ProjectItem) {
        const view = context as ProjectItem;
        await setEnvironmentCommand([view.project.uri], em, wm);
    } else if (context instanceof GlobalProjectItem) {
        await setEnvironmentCommand(undefined, em, wm);
    } else if (context instanceof Uri) {
        await setEnvironmentCommand([context], em, wm);
    } else if (context === undefined) {
        try {
            const projects = wm.getProjects();
            if (projects.length > 0) {
                const selected = await pickProjectMany(projects);
                if (selected && selected.length > 0) {
                    const uris = selected.map((p) => p.uri);
                    await setEnvironmentCommand(uris, em, wm);
                }
            } else {
                const globalEnvManager = em.getEnvironmentManager(undefined);
                const recommended = globalEnvManager ? await globalEnvManager.get(undefined) : undefined;
                const selected = await pickEnvironment(em.managers, globalEnvManager ? [globalEnvManager] : [], {
                    projects: [],
                    recommended,
                    showBackButton: false,
                });
                if (selected) {
                    await em.setEnvironments('global', selected);
                }
            }
        } catch (ex) {
            if (ex === QuickInputButtons.Back) {
                await setEnvironmentCommand(context, em, wm);
            }
            throw ex;
        }
    } else if (Array.isArray(context) && context.length > 0 && context.every((c) => c instanceof Uri)) {
        const uris = context as Uri[];
        const projects = wm.getProjects(uris).map((p) => p);
        const projectEnvManagers = em.getProjectEnvManagers(uris);
        const recommended =
            projectEnvManagers.length === 1 && uris.length === 1 ? await projectEnvManagers[0].get(uris[0]) : undefined;
        const selected = await pickEnvironment(em.managers, projectEnvManagers, {
            projects,
            recommended,
            showBackButton: uris.length > 1,
        });

        if (selected) {
            await em.setEnvironments(uris, selected);
        }
    } else {
        traceError(`Invalid context for setting environment command: ${context}`);
        showErrorMessage('Invalid context for setting environment');
    }
}

export async function resetEnvironmentCommand(
    context: unknown,
    em: EnvironmentManagers,
    wm: PythonProjectManager,
): Promise<void> {
    if (context instanceof ProjectItem) {
        const view = context as ProjectItem;
        return resetEnvironmentCommand(view.project.uri, em, wm);
    } else if (context instanceof Uri) {
        const uri = context as Uri;
        const manager = em.getEnvironmentManager(uri);
        if (manager) {
            manager.set(uri, undefined);
        } else {
            showErrorMessage(`No environment manager found for: ${uri.fsPath}`);
            traceError(`No environment manager found for ${uri.fsPath}`);
        }
        return;
    } else if (context === undefined) {
        const pw = await pickProject(wm.getProjects());
        if (pw) {
            return resetEnvironmentCommand(pw.uri, em, wm);
        }
        return;
    }
    traceError(`Invalid context for unset environment command: ${context}`);
    showErrorMessage('Invalid context for unset environment');
}

export async function setEnvManagerCommand(em: EnvironmentManagers, wm: PythonProjectManager): Promise<void> {
    const projects = await pickProjectMany(wm.getProjects());
    if (projects && projects.length > 0) {
        const manager = await pickEnvironmentManager(em.managers);
        if (manager) {
            await setEnvironmentManager(projects.map((p) => ({ project: p, envManager: manager })));
        }
    }
}

export async function setPackageManagerCommand(em: EnvironmentManagers, wm: PythonProjectManager): Promise<void> {
    const projects = await pickProjectMany(wm.getProjects());
    if (projects && projects.length > 0) {
        const manager = await pickPackageManager(em.packageManagers);
        if (manager) {
            await setPackageManager(projects.map((p) => ({ project: p, packageManager: manager })));
        }
    }
}

export async function addPythonProject(
    resource: unknown,
    wm: PythonProjectManager,
    em: EnvironmentManagers,
    pc: ProjectCreators,
): Promise<PythonProject | PythonProject[] | undefined> {
    if (wm.getProjects().length === 0) {
        showErrorMessage('Please open a folder/project before adding a workspace');
        return;
    }

    if (resource instanceof Uri) {
        const uri = resource as Uri;
        const envManagerId = getDefaultEnvManagerSetting(wm, uri);
        const pkgManagerId = getDefaultPkgManagerSetting(
            wm,
            uri,
            em.getEnvironmentManager(envManagerId)?.preferredPackageManagerId,
        );
        const pw = wm.create(path.basename(uri.fsPath), uri);
        await addPythonProjectSetting([{ project: pw, envManager: envManagerId, packageManager: pkgManagerId }]);
        return pw;
    }

    if (resource === undefined || resource instanceof ProjectItem) {
        const creator: PythonProjectCreator | undefined = await pickCreator(pc.getProjectCreators());
        if (!creator) {
            return;
        }

        let results: PythonProject | PythonProject[] | undefined;
        try {
            results = await creator.create();
            if (results === undefined) {
                return;
            }
        } catch (ex) {
            if (ex === QuickInputButtons.Back) {
                return addPythonProject(resource, wm, em, pc);
            }
            throw ex;
        }

        if (!Array.isArray(results)) {
            results = [results];
        }

        if (Array.isArray(results)) {
            if (results.length === 0) {
                return;
            }
        }

        const projects: PythonProject[] = [];
        const edits: EditProjectSettings[] = [];

        for (const result of results) {
            const uri = await getAbsolutePath(result.uri.fsPath);
            if (!uri) {
                traceError(`Path does not belong to any opened workspace: ${result.uri.fsPath}`);
                continue;
            }

            const envManagerId = getDefaultEnvManagerSetting(wm, uri);
            const pkgManagerId = getDefaultPkgManagerSetting(
                wm,
                uri,
                em.getEnvironmentManager(envManagerId)?.preferredPackageManagerId,
            );
            const pw = wm.create(path.basename(uri.fsPath), uri);
            projects.push(pw);
            edits.push({ project: pw, envManager: envManagerId, packageManager: pkgManagerId });
        }
        await addPythonProjectSetting(edits);
        return projects;
    }
}

export async function removePythonProject(item: ProjectItem, wm: PythonProjectManager): Promise<void> {
    await removePythonProjectSetting([{ project: item.project }]);
    wm.remove(item.project);
}

export async function getPackageCommandOptions(
    e: unknown,
    em: EnvironmentManagers,
    pm: PythonProjectManager,
): Promise<{
    packageManager: InternalPackageManager;
    environment: PythonEnvironment;
}> {
    if (e === undefined) {
        const project = await pickProject(pm.getProjects());
        if (project) {
            return getPackageCommandOptions(project.uri, em, pm);
        }
    }

    if (e instanceof ProjectEnvironment) {
        const environment = e.environment;
        const packageManager = em.getPackageManager(e.parent.project.uri);
        if (packageManager) {
            return { environment, packageManager };
        }
    }

    if (e instanceof PythonEnvTreeItem) {
        const environment = e.environment;
        const packageManager = em.getPackageManager(environment);
        if (packageManager) {
            return { environment, packageManager };
        }
    }

    if (e instanceof Uri) {
        const environment = await em.getEnvironmentManager(e)?.get(e);
        const packageManager = em.getPackageManager(e);
        if (environment && packageManager) {
            return { environment, packageManager };
        }
    }

    throw new Error(`Invalid context for package command: ${e}`);
}

export async function createTerminalCommand(
    context: unknown,
    api: PythonEnvironmentApi,
    tm: TerminalManager,
): Promise<Terminal | undefined> {
    if (context instanceof Uri) {
        const uri = context as Uri;
        const env = await api.getEnvironment(uri);
        const pw = api.getPythonProject(uri);
        if (env && pw) {
            return await tm.create(env, { cwd: pw.uri });
        }
    } else if (context instanceof ProjectItem) {
        const view = context as ProjectItem;
        const env = await api.getEnvironment(view.project.uri);
        if (env) {
            const terminal = await tm.create(env, { cwd: view.project.uri });
            terminal.show();
            return terminal;
        }
    } else if (context instanceof GlobalProjectItem) {
        const env = await api.getEnvironment(undefined);
        if (env) {
            const terminal = await tm.create(env, { cwd: undefined });
            terminal.show();
            return terminal;
        }
    } else if (context instanceof PythonEnvTreeItem) {
        const view = context as PythonEnvTreeItem;
        const pw = await pickProject(api.getPythonProjects());
        if (pw) {
            const terminal = await tm.create(view.environment, { cwd: pw.uri });
            terminal.show();
            return terminal;
        }
    }
}

export async function runInTerminalCommand(
    item: unknown,
    api: PythonEnvironmentApi,
    tm: TerminalManager,
): Promise<void> {
    if (item instanceof Uri) {
        const uri = item as Uri;
        const project = api.getPythonProject(uri);
        const environment = await api.getEnvironment(uri);
        if (environment && project) {
            const terminal = await tm.getProjectTerminal(project, environment);
            await runInTerminal(environment, terminal, {
                cwd: project.uri,
                args: [item.fsPath],
                show: true,
            });
        }
    }
    throw new Error(`Invalid context for run-in-terminal: ${item}`);
}

export async function runInDedicatedTerminalCommand(
    item: unknown,
    api: PythonEnvironmentApi,
    tm: TerminalManager,
): Promise<void> {
    if (item instanceof Uri) {
        const uri = item as Uri;
        const project = api.getPythonProject(uri);
        const environment = await api.getEnvironment(uri);
        if (environment && project) {
            const terminal = await tm.getDedicatedTerminal(item, project, environment);
            await runInTerminal(environment, terminal, {
                cwd: project.uri,
                args: [item.fsPath],
                show: true,
            });
        }
    }
    throw new Error(`Invalid context for run-in-terminal: ${item}`);
}

export async function runAsTaskCommand(item: unknown, api: PythonEnvironmentApi): Promise<TaskExecution | undefined> {
    if (item instanceof Uri) {
        const uri = item as Uri;
        const project = api.getPythonProject(uri);
        const environment = await api.getEnvironment(uri);
        if (environment) {
            return await runAsTask(
                environment,
                {
                    project,
                    args: [item.fsPath],
                    name: 'Python Run',
                },

                { reveal: TaskRevealKind.Always },
            );
        }
    } else if (item === undefined) {
        const uri = activeTextEditor()?.document.uri;
        if (uri) {
            return runAsTaskCommand(uri, api);
        }
    }
}

export async function copyPathToClipboard(item: unknown): Promise<void> {
    if (item instanceof ProjectItem) {
        const projectPath = item.project.uri.fsPath;
        await clipboardWriteText(projectPath);
        traceInfo(`Copied project path to clipboard: ${projectPath}`);
    } else if (item instanceof ProjectEnvironment || item instanceof PythonEnvTreeItem) {
        const run = item.environment.execInfo.activatedRun ?? item.environment.execInfo.run;
        const envPath = quoteArgs([run.executable, ...(run.args ?? [])]).join(' ');
        await clipboardWriteText(envPath);
        traceInfo(`Copied environment path to clipboard: ${envPath}`);
    } else {
        traceVerbose(`Invalid context for copy path to clipboard: ${item}`);
    }
}
