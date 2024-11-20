import { Uri, ThemeIcon, QuickPickItem, QuickPickItemKind, ProgressLocation, QuickInputButtons } from 'vscode';
import { IconPath, PythonEnvironment, PythonProject } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';
import { Common, Interpreter } from '../localize';
import { showQuickPickWithButtons, showQuickPick, showOpenDialog, withProgress } from '../window.apis';
import { isWindows } from '../../managers/common/utils';
import { traceError } from '../logging';
import { pickEnvironmentManager } from './managers';
import { handlePythonPath } from '../utils/pythonPath';

type QuickPickIcon =
    | Uri
    | {
          light: Uri;
          dark: Uri;
      }
    | ThemeIcon
    | undefined;

function getIconPath(i: IconPath | undefined): QuickPickIcon {
    if (i === undefined || i instanceof ThemeIcon) {
        return i;
    }

    if (i instanceof Uri) {
        return i.fsPath.endsWith('__icon__.py') ? undefined : i;
    }

    if (typeof i === 'string') {
        return Uri.file(i);
    }

    return {
        light: i.light instanceof Uri ? i.light : Uri.file(i.light),
        dark: i.dark instanceof Uri ? i.dark : Uri.file(i.dark),
    };
}

interface EnvironmentPickOptions {
    recommended?: PythonEnvironment;
    showBackButton?: boolean;
    projects: PythonProject[];
}
async function browseForPython(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
): Promise<PythonEnvironment | undefined> {
    const filters = isWindows() ? { python: ['exe'] } : undefined;
    const uris = await showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters,
        title: 'Select Python executable',
    });
    if (!uris || uris.length === 0) {
        return;
    }
    const uri = uris[0];

    const environment = await withProgress(
        {
            location: ProgressLocation.Notification,
            cancellable: false,
        },
        async (reporter, token) => {
            const env = await handlePythonPath(uri, managers, projectEnvManagers, reporter, token);
            return env;
        },
    );
    return environment;
}

async function createEnvironment(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const managerId = await pickEnvironmentManager(
        managers.filter((m) => m.supportsCreate),
        projectEnvManagers.filter((m) => m.supportsCreate),
    );

    const manager = managers.find((m) => m.id === managerId);
    if (manager) {
        try {
            const env = await manager.create(options.projects.map((p) => p.uri));
            return env;
        } catch (ex) {
            if (ex === QuickInputButtons.Back) {
                return createEnvironment(managers, projectEnvManagers, options);
            }
            traceError(`Failed to create environment using ${manager.id}`, ex);
            throw ex;
        }
    }
}

async function pickEnvironmentImpl(
    items: (QuickPickItem | (QuickPickItem & { result: PythonEnvironment }))[],
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const selected = await showQuickPickWithButtons(items, {
        placeHolder: `Select a Python Environment`,
        ignoreFocusOut: true,
        showBackButton: options?.showBackButton,
    });

    if (selected && !Array.isArray(selected)) {
        if (selected.label === Interpreter.browsePath) {
            return browseForPython(managers, projectEnvManagers);
        } else if (selected.label === Interpreter.createVirtualEnvironment) {
            return createEnvironment(managers, projectEnvManagers, options);
        }
        return (selected as { result: PythonEnvironment })?.result;
    }
    return undefined;
}

export async function pickEnvironment(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const items: (QuickPickItem | (QuickPickItem & { result: PythonEnvironment }))[] = [
        {
            label: Interpreter.browsePath,
            iconPath: new ThemeIcon('folder'),
        },
        {
            label: '',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: Interpreter.createVirtualEnvironment,
            iconPath: new ThemeIcon('add'),
        },
    ];

    if (options?.recommended) {
        items.push(
            {
                label: Common.recommended,
                kind: QuickPickItemKind.Separator,
            },
            {
                label: options.recommended.displayName,
                description: options.recommended.description,
                result: options.recommended,
                iconPath: getIconPath(options.recommended.iconPath),
            },
        );
    }

    for (const manager of managers) {
        items.push({
            label: manager.displayName,
            kind: QuickPickItemKind.Separator,
        });
        const envs = await manager.getEnvironments('all');
        items.push(
            ...envs.map((e) => {
                return {
                    label: e.displayName ?? e.name,
                    description: e.description,
                    result: e,
                    manager: manager,
                    iconPath: getIconPath(e.iconPath),
                };
            }),
        );
    }

    return pickEnvironmentImpl(items, managers, projectEnvManagers, options);
}

export async function pickEnvironmentFrom(environments: PythonEnvironment[]): Promise<PythonEnvironment | undefined> {
    const items = environments.map((e) => ({
        label: e.displayName ?? e.name,
        description: e.description,
        e: e,
        iconPath: getIconPath(e.iconPath),
    }));
    const selected = await showQuickPick(items, {
        placeHolder: 'Select Python Environment',
        ignoreFocusOut: true,
    });
    return (selected as { e: PythonEnvironment })?.e;
}
