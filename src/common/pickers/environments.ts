import {
    ProgressLocation,
    QuickInputButton,
    QuickInputButtons,
    QuickPick,
    QuickPickItem,
    QuickPickItemKind,
    ThemeIcon,
    Uri,
    l10n,
} from 'vscode';
import { CreateEnvironmentOptions, IconPath, PythonEnvironment, PythonProject } from '../../api';
import type { InternalEnvironmentManager } from '../../managers/common/registeredManagers';
import { showErrorMessageWithLogs } from '../errors/utils';
import { Common, Interpreter, Pickers } from '../localize';
import { traceError } from '../logging';
import { EventNames } from '../telemetry/constants';
import { sendTelemetryEvent } from '../telemetry/sender';
import { isWindows } from '../utils/platformUtils';
import { handlePythonPath } from '../utils/pythonPath';
import {
    showErrorMessage,
    showInputBox,
    showOpenDialog,
    showQuickPick,
    showQuickPickWithButtons,
    withProgress,
} from '../window.apis';
import { getWorkspaceFolders } from '../workspace.apis';
import { pickEnvironmentManager } from './managers';

type QuickPickIcon =
    | Uri
    | {
          light: Uri;
          dark: Uri;
      }
    | ThemeIcon
    | undefined;

interface EnvironmentPickItem extends QuickPickItem {
    readonly result?: PythonEnvironment;
}

const REFRESH_ENVIRONMENTS_BUTTON: QuickInputButton = {
    iconPath: new ThemeIcon('refresh'),
    tooltip: Pickers.Environments.refresh,
};
const inFlightManagerRefreshes = new WeakMap<InternalEnvironmentManager, Promise<void>>();
let refreshErrorNotificationShown = false;

function getIconPath(i: IconPath | undefined): QuickPickIcon {
    if (i === undefined || i instanceof ThemeIcon || i instanceof Uri) {
        return i;
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

function isSameEnvironment(left: PythonEnvironment, right: PythonEnvironment): boolean {
    return left.envId.id === right.envId.id && left.envId.managerId === right.envId.managerId;
}

function getEnvironmentDescription(environment: PythonEnvironment): string {
    return environment.description?.trim()
        ? `${environment.description} (${environment.displayPath})`
        : environment.displayPath;
}

function createEnvironmentPickItem(
    environment: PythonEnvironment,
): EnvironmentPickItem {
    return {
        label: environment.displayName ?? environment.name,
        description: getEnvironmentDescription(environment),
        result: environment,
        iconPath: getIconPath(environment.iconPath),
    };
}

async function buildEnvironmentPickItems(
    managers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<EnvironmentPickItem[]> {
    const items: EnvironmentPickItem[] = [
        {
            label: Interpreter.enterInterpreterPath,
            iconPath: new ThemeIcon('edit'),
        },
        {
            label: Interpreter.browsePath,
            iconPath: new ThemeIcon('folder'),
        },
    ];

    if (getWorkspaceFolders()?.length) {
        items.push(
            {
                label: '',
                kind: QuickPickItemKind.Separator,
            },
            {
                label: Interpreter.createVirtualEnvironment,
                iconPath: new ThemeIcon('add'),
            },
        );
    }

    if (options.recommended) {
        items.push(
            {
                label: Common.recommended,
                kind: QuickPickItemKind.Separator,
            },
            createEnvironmentPickItem(options.recommended),
        );
    }

    for (const manager of managers) {
        items.push({
            label: manager.displayName,
            kind: QuickPickItemKind.Separator,
        });
        const environments = await manager.getEnvironments('all');
        items.push(...environments.map((environment) => createEnvironmentPickItem(environment)));
    }

    return items;
}

function findEquivalentPickItem(
    items: readonly EnvironmentPickItem[],
    previous: EnvironmentPickItem | undefined,
): EnvironmentPickItem | undefined {
    if (previous?.result) {
        const previousResult = previous.result;
        return items.find((item) => item.result !== undefined && isSameEnvironment(item.result, previousResult));
    }
    return previous ? items.find((item) => item.label === previous.label) : undefined;
}

function refreshManager(manager: InternalEnvironmentManager): Promise<void> {
    const inFlight = inFlightManagerRefreshes.get(manager);
    if (inFlight) {
        return inFlight;
    }

    const refresh = manager.refresh(undefined);
    inFlightManagerRefreshes.set(manager, refresh);
    const clearRefresh = () => {
        if (inFlightManagerRefreshes.get(manager) === refresh) {
            inFlightManagerRefreshes.delete(manager);
        }
    };
    void refresh.then(clearRefresh, clearRefresh);
    return refresh;
}

async function refreshEnvironmentPickItems(
    managers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
    quickPick: QuickPick<EnvironmentPickItem>,
): Promise<void> {
    let hidden = false;
    const hideDisposable = quickPick.onDidHide(() => {
        hidden = true;
    });
    const activeItem = quickPick.activeItems[0];
    quickPick.busy = true;
    quickPick.enabled = false;

    try {
        await Promise.all(managers.map((manager) => refreshManager(manager)));
        if (hidden) {
            return;
        }

        const items = await buildEnvironmentPickItems(managers, options);
        if (hidden) {
            return;
        }

        quickPick.keepScrollPosition = true;
        quickPick.items = items;
        const recommended = options.recommended;
        const preservedItem =
            findEquivalentPickItem(items, activeItem) ??
            (recommended
                ? items.find((item) => item.result !== undefined && isSameEnvironment(item.result, recommended))
                : undefined);
        if (preservedItem) {
            quickPick.activeItems = [preservedItem];
        }
    } catch (error) {
        traceError('Failed to refresh environments from the environment picker:', error);
        if (!hidden && !refreshErrorNotificationShown) {
            refreshErrorNotificationShown = true;
            void showErrorMessageWithLogs(Pickers.Environments.refreshFailed).catch((notificationError) =>
                traceError('Failed to show the environment refresh error notification:', notificationError),
            );
        }
    } finally {
        hideDisposable.dispose();
        if (!hidden) {
            quickPick.busy = false;
            quickPick.enabled = true;
        }
    }
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
        title: Pickers.Environments.selectExecutable,
    });
    if (!uris || uris.length === 0) {
        return;
    }
    return resolvePython(uris[0], managers, projectEnvManagers);
}

async function enterPythonPath(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
): Promise<PythonEnvironment | undefined> {
    const interpreterPath = await showInputBox({
        title: Interpreter.enterInterpreterPath,
        prompt: l10n.t('Enter the full path to a Python interpreter'),
        ignoreFocusOut: true,
    });
    if (!interpreterPath?.trim()) {
        return;
    }
    return resolvePython(Uri.file(interpreterPath.trim()), managers, projectEnvManagers);
}

async function resolvePython(
    uri: Uri,
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
): Promise<PythonEnvironment | undefined> {
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

    if (!environment) {
        showErrorMessage(l10n.t('Selected file is not a valid Python interpreter: {0}', uri.fsPath));
    }

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

    let manager: InternalEnvironmentManager | undefined;
    let createOptions: CreateEnvironmentOptions | undefined = undefined;
    if (managerId?.includes(`QuickCreate#`)) {
        manager = managers.find((m) => m.id === managerId.split('#')[1]);
        createOptions = {
            projects: projectEnvManagers.map((m) => m),
            quickCreate: true,
        } as CreateEnvironmentOptions;
    } else {
        manager = managers.find((m) => m.id === managerId);
    }

    if (manager) {
        try {
            // add telemetry here
            const env = await manager.create(
                options.projects.map((p) => p.uri),
                createOptions,
            );
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
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const items = await buildEnvironmentPickItems(managers, options);
    let refreshInProgress: Promise<void> | undefined;
    const selected = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Environments.selectEnvironment,
        ignoreFocusOut: true,
        showBackButton: options?.showBackButton,
        buttons: [REFRESH_ENVIRONMENTS_BUTTON],
        buttonHandler: (button, quickPick) => {
            if (button !== REFRESH_ENVIRONMENTS_BUTTON) {
                return;
            }
            if (!refreshInProgress) {
                const refresh = refreshEnvironmentPickItems(managers, options, quickPick);
                refreshInProgress = refresh;
                const clearRefresh = () => {
                    if (refreshInProgress === refresh) {
                        refreshInProgress = undefined;
                    }
                };
                void refresh.then(clearRefresh, clearRefresh);
            }
            return refreshInProgress;
        },
    });

    if (selected && !Array.isArray(selected)) {
        if (selected.label === Interpreter.browsePath) {
            return browseForPython(managers, projectEnvManagers);
        } else if (selected.label === Interpreter.enterInterpreterPath) {
            return enterPythonPath(managers, projectEnvManagers);
        } else if (selected.label === Interpreter.createVirtualEnvironment) {
            sendTelemetryEvent(EventNames.CREATE_ENVIRONMENT, undefined, {
                manager: 'none',
                triggeredLocation: 'pickEnv',
            });
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
    return pickEnvironmentImpl(managers, projectEnvManagers, options);
}

export async function pickEnvironmentFrom(environments: PythonEnvironment[]): Promise<PythonEnvironment | undefined> {
    const items = environments.map((e) => {
        const pathDescription = e.displayPath;
        const description =
            e.description && e.description.trim() ? `${e.description} (${pathDescription})` : pathDescription;

        return {
            label: e.displayName ?? e.name,
            description: description,
            e: e,
            iconPath: getIconPath(e.iconPath),
        };
    });
    const selected = await showQuickPick(items, {
        placeHolder: Pickers.Environments.selectEnvironment,
        ignoreFocusOut: true,
    });
    return (selected as { e: PythonEnvironment })?.e;
}
