import { QuickInputButtons, TaskExecution, TaskRevealKind, Terminal, Uri, window } from 'vscode';
import {
    EnvironmentManagers,
    InternalEnvironmentManager,
    InternalPackageManager,
    ProjectCreators,
    PythonProjectManager,
    PythonTaskExecutionOptions,
    PythonTerminalExecutionOptions,
} from '../internal.api';
import { traceError, traceVerbose } from '../common/logging';
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
    setAllManagerSettings,
    EditAllManagerSettings,
} from './settings/settingHelpers';

import { getAbsolutePath } from '../common/utils/fileNameUtils';
import { createPythonTerminal } from './execution/terminal';
import { runInTerminal } from './execution/runInTerminal';
import { runAsTask } from './execution/runAsTask';
import {
    EnvManagerTreeItem,
    PackageRootTreeItem,
    PythonEnvTreeItem,
    ProjectItem,
    ProjectEnvironment,
    ProjectPackageRootTreeItem,
} from './views/treeViewItems';
import { Common } from '../common/localize';
import { pickEnvironment } from '../common/pickers/environments';
import { pickEnvironmentManager, pickPackageManager, pickCreator } from '../common/pickers/managers';
import { pickPackageOptions, getPackagesToInstall, getPackagesToUninstall } from '../common/pickers/packages';
import { pickProject, pickProjectMany } from '../common/pickers/projects';

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
    managers: EnvironmentManagers,
    projects: PythonProjectManager,
): Promise<void> {
    if (context instanceof EnvManagerTreeItem) {
        const manager = (context as EnvManagerTreeItem).manager;
        await manager.create('global');
    } else if (context instanceof Uri) {
        const manager = managers.getEnvironmentManager(context as Uri);
        const project = projects.get(context as Uri);
        if (project) {
            await manager?.create(project.uri);
        }
    } else {
        traceError(`Invalid context for create command: ${context}`);
    }
}

export async function createAnyEnvironmentCommand(em: EnvironmentManagers, pm: PythonProjectManager): Promise<void> {
    const projects = await pickProjectMany(pm.getProjects());
    if (projects && projects.length > 0) {
        const defaultManagers: InternalEnvironmentManager[] = [];
        projects.forEach((p) => {
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
            await manager.create(projects.map((p) => p.uri));
        }
    }
}

export async function removeEnvironmentCommand(context: unknown, managers: EnvironmentManagers): Promise<void> {
    if (context instanceof PythonEnvTreeItem) {
        const view = context as PythonEnvTreeItem;
        const manager = view.parent.manager;
        await manager.remove(view.environment);
    } else if (context instanceof Uri) {
        const manager = managers.getEnvironmentManager(context as Uri);
        const environment = await manager?.get(context as Uri);
        if (environment) {
            await manager?.remove(environment);
        }
    } else {
        traceError(`Invalid context for remove command: ${context}`);
    }
}

export async function handlePackagesCommand(
    packageManager: InternalPackageManager,
    environment: PythonEnvironment,
    packages?: string[],
): Promise<void> {
    const action = await pickPackageOptions();

    if (action === Common.install) {
        if (!packages || packages.length === 0) {
            try {
                packages = await getPackagesToInstall(packageManager, environment);
            } catch (ex: any) {
                if (ex === QuickInputButtons.Back) {
                    return handlePackagesCommand(packageManager, environment, packages);
                }
            }
        }
        if (packages && packages.length > 0) {
            return packageManager.install(environment, packages, { upgrade: false });
        }
    }

    if (action === Common.uninstall) {
        if (!packages || packages.length === 0) {
            const allPackages = await packageManager.getPackages(environment);
            if (allPackages && allPackages.length > 0) {
                packages = (await getPackagesToUninstall(allPackages))?.map((p) => p.name);
            }

            if (packages && packages.length > 0) {
                return packageManager.uninstall(environment, packages);
            }
        }
    }
}

export interface EnvironmentSetResult {
    projects?: PythonProject;
    environment: PythonEnvironment;
}

export async function setEnvironmentCommand(
    context: unknown,
    em: EnvironmentManagers,
    wm: PythonProjectManager,
): Promise<EnvironmentSetResult[] | undefined> {
    if (context instanceof PythonEnvTreeItem) {
        const view = context as PythonEnvTreeItem;
        const manager = view.parent.manager;
        const projects = await pickProjectMany(wm.getProjects());
        if (projects && projects.length > 0) {
            await Promise.all(projects.map((p) => manager.set(p.uri, view.environment)));
            await setAllManagerSettings(
                projects.map((p) => ({
                    project: p,
                    envManager: manager.id,
                    packageManager: manager.preferredPackageManagerId,
                })),
            );
            return projects.map((p) => ({ project: [p], environment: view.environment }));
        }
        return;
    } else if (context instanceof ProjectItem) {
        const view = context as ProjectItem;
        return setEnvironmentCommand(view.project.uri, em, wm);
    } else if (context instanceof Uri) {
        return setEnvironmentCommand([context], em, wm);
    } else if (context === undefined) {
        const project = await pickProjectMany(wm.getProjects());
        if (project && project.length > 0) {
            try {
                const result = setEnvironmentCommand(project, em, wm);
                return result;
            } catch (ex) {
                if (ex === QuickInputButtons.Back) {
                    return setEnvironmentCommand(context, em, wm);
                }
            }
        }
        return;
    } else if (Array.isArray(context) && context.length > 0 && context.every((c) => c instanceof Uri)) {
        const uris = context as Uri[];
        const projects: PythonProject[] = [];
        const projectEnvManagers: InternalEnvironmentManager[] = [];
        uris.forEach((uri) => {
            const project = wm.get(uri);
            if (project) {
                projects.push(project);
                const manager = em.getEnvironmentManager(uri);
                if (manager && !projectEnvManagers.includes(manager)) {
                    projectEnvManagers.push(manager);
                }
            }
        });

        const recommended =
            projectEnvManagers.length === 1 && uris.length === 1 ? await projectEnvManagers[0].get(uris[0]) : undefined;
        const selected = await pickEnvironment(em.managers, projectEnvManagers, {
            projects,
            recommended,
            showBackButton: uris.length > 1,
        });
        const manager = em.managers.find((m) => m.id === selected?.envId.managerId);
        if (selected && manager) {
            const promises: Thenable<void>[] = [];
            const settings: EditAllManagerSettings[] = [];
            uris.forEach((uri) => {
                const m = em.getEnvironmentManager(uri);
                if (manager.id !== m?.id) {
                    promises.push(manager.set(uri, selected));
                    settings.push({
                        project: wm.get(uri),
                        envManager: manager.id,
                        packageManager: manager.preferredPackageManagerId,
                    });
                }
            });
            await Promise.all(promises);
            await setAllManagerSettings(settings);
            return [...projects.map((p) => ({ project: p, environment: selected }))];
        }
        return;
    }
    traceError(`Invalid context for setting environment command: ${context}`);
    window.showErrorMessage('Invalid context for setting environment');
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
            window.showErrorMessage(`No environment manager found for: ${uri.fsPath}`);
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
    window.showErrorMessage('Invalid context for unset environment');
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
        window.showErrorMessage('Please open a folder/project before adding a workspace');
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

    if (resource === undefined) {
        const creator: PythonProjectCreator | undefined = await pickCreator(pc.getProjectCreators());
        if (!creator) {
            return;
        }

        let results = await creator.create();
        if (results === undefined) {
            return;
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
): Promise<Terminal | undefined> {
    if (context instanceof Uri) {
        const uri = context as Uri;
        const env = await api.getEnvironment(uri);
        const pw = api.getPythonProject(uri);
        if (env && pw) {
            return await createPythonTerminal(env, pw.uri);
        }
    } else if (context instanceof ProjectItem) {
        const view = context as ProjectItem;
        const env = await api.getEnvironment(view.project.uri);
        if (env) {
            const terminal = await createPythonTerminal(env, view.project.uri);
            terminal.show();
            return terminal;
        }
    } else if (context instanceof PythonEnvTreeItem) {
        const view = context as PythonEnvTreeItem;
        const pw = await pickProject(api.getPythonProjects());
        if (pw) {
            const terminal = await createPythonTerminal(view.environment, pw.uri);
            terminal.show();
            return terminal;
        }
    }
}

export async function runInTerminalCommand(item: unknown, api: PythonEnvironmentApi): Promise<void> {
    const keys = Object.keys(item ?? {});
    if (item instanceof Uri) {
        const uri = item as Uri;
        const project = api.getPythonProject(uri);
        const environment = await api.getEnvironment(uri);
        if (environment && project) {
            await runInTerminal(
                {
                    project,
                    args: [item.fsPath],
                },
                environment,
                { show: true },
            );
        }
    } else if (keys.includes('project') && keys.includes('args')) {
        const options = item as PythonTerminalExecutionOptions;
        const environment = await api.getEnvironment(options.project.uri);
        if (environment) {
            await runInTerminal(options, environment, { show: true });
        }
    }
}

export async function runAsTaskCommand(item: unknown, api: PythonEnvironmentApi): Promise<TaskExecution | undefined> {
    const keys = Object.keys(item ?? {});
    if (item instanceof Uri) {
        const uri = item as Uri;
        const project = api.getPythonProject(uri);
        const environment = await api.getEnvironment(uri);
        if (environment && project) {
            return await runAsTask(
                {
                    project,
                    args: [item.fsPath],
                    name: 'Python Run',
                },
                environment,
                { reveal: TaskRevealKind.Always },
            );
        }
    } else if (keys.includes('project') && keys.includes('args') && keys.includes('name')) {
        const options = item as PythonTaskExecutionOptions;
        const environment = await api.getEnvironment(options.project.uri);
        if (environment) {
            return await runAsTask(options, environment);
        }
    } else if (item === undefined) {
        const uri = window.activeTextEditor?.document.uri;
        if (uri) {
            return runAsTaskCommand(uri, api);
        }
    }
}
