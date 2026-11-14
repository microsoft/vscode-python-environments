import {
    QuickInputButtons,
    QuickPickItem,
    QuickPickItemKind,
    ThemeIcon,
    Uri,
    workspace,
    WorkspaceFolder,
} from 'vscode';
import { PythonProjectCreator } from '../../api';
import type {
    InternalEnvironmentManager,
    InternalPackageManager,
} from '../../managers/common/registeredManagers';
import { executeCommand } from '../command.api';
import { Common, Interpreter, Pickers, ProjectCreatorString } from '../localize';
import { showQuickPickWithButtons } from '../window.apis';

export const ENTER_INTERPRETER_PATH_ID = 'EnterInterpreterPath';

function getDescription(mgr: InternalEnvironmentManager | InternalPackageManager): string | undefined {
    if (mgr.description) {
        return mgr.description;
    }
    if (mgr.tooltip) {
        const tooltip = mgr.tooltip;
        if (typeof tooltip === 'string') {
            return tooltip;
        }
        return tooltip.value;
    }
    return undefined;
}

export async function pickEnvironmentManager(
    managers: InternalEnvironmentManager[],
    defaultManagers?: InternalEnvironmentManager[],
    showBackButton?: boolean,
    showEnterInterpreterPath?: boolean,
): Promise<string | undefined> {
    if (managers.length === 0) {
        return;
    }

    if (managers.length === 1 && !managers[0].supportsQuickCreate && !showEnterInterpreterPath) {
        // If there's only one manager and it doesn't support quick create, return its ID directly.
        return managers[0].id;
    }

    const items: (QuickPickItem | (QuickPickItem & { id: string }))[] = [];

    if (defaultManagers && defaultManagers.length > 0) {
        items.push({
            label: Common.recommended,
            kind: QuickPickItemKind.Separator,
        });
        if (defaultManagers.length === 1 && defaultManagers[0].supportsQuickCreate) {
            const defaultMgr = defaultManagers[0];
            const details = defaultMgr.quickCreateConfig();
            if (details) {
                items.push({
                    label: Common.quickCreate,
                    description: `${defaultMgr.displayName} • ${details.description}`,
                    detail: details.detail,
                    id: `QuickCreate#${defaultMgr.id}`,
                });
            }
        }
        items.push(
            ...defaultManagers.map((defaultMgr) => ({
                label: defaultMgr.displayName,
                description: getDescription(defaultMgr),
                id: defaultMgr.id,
            })),
            {
                label: '',
                kind: QuickPickItemKind.Separator,
            },
        );
    }
    items.push(
        ...managers
            .filter((m) => !defaultManagers?.includes(m))
            .map((m) => ({
                label: m.displayName,
                description: getDescription(m),
                id: m.id,
            })),
    );

    // Add "Enter Interpreter Path" option at the bottom if enabled
    if (showEnterInterpreterPath) {
        items.push(
            {
                label: '',
                kind: QuickPickItemKind.Separator,
            },
            {
                label: Interpreter.enterInterpreterPath,
                description: Interpreter.enterInterpreterPathDescription,
                id: ENTER_INTERPRETER_PATH_ID,
                iconPath: new ThemeIcon('folder-opened'),
            },
        );
    }

    const item = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Managers.selectEnvironmentManager,
        ignoreFocusOut: true,
        showBackButton,
    });
    return (item as QuickPickItem & { id: string })?.id;
}

export async function pickPackageManager(
    managers: InternalPackageManager[],
    defaultManagers?: InternalPackageManager[],
): Promise<string | undefined> {
    if (managers.length === 0) {
        return;
    }

    if (managers.length === 1) {
        return managers[0].id;
    }

    const items: (QuickPickItem | (QuickPickItem & { id: string }))[] = [];
    if (defaultManagers && defaultManagers.length > 0) {
        items.push(
            {
                label: Common.recommended,
                kind: QuickPickItemKind.Separator,
            },
            ...defaultManagers.map((defaultMgr) => ({
                label: defaultMgr.displayName,
                description: getDescription(defaultMgr),
                id: defaultMgr.id,
            })),
            {
                label: '',
                kind: QuickPickItemKind.Separator,
            },
        );
    }
    items.push(
        ...managers
            .filter((m) => !defaultManagers?.includes(m))
            .map((m) => ({
                label: m.displayName,
                description: getDescription(m),
                id: m.id,
            })),
    );
    const item = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Managers.selectPackageManager,
        ignoreFocusOut: true,
    });
    return (item as QuickPickItem & { id: string })?.id;
}

export async function pickWorkspaceFolder(showBackButton = true): Promise<WorkspaceFolder | undefined> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    const items = folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        folder: f,
    }));

    const selected = await showQuickPickWithButtons(items, {
        placeHolder: 'Select a workspace folder',
        ignoreFocusOut: true,
        showBackButton,
    });
    if (!selected) {
        return undefined;
    }
    const selectedItem = Array.isArray(selected) ? selected[0] : selected;
    return selectedItem?.folder;
}
/** A project directory found from pyproject.toml or setup.py before the quick pick opens. */
export interface DiscoveredProjectOption {
    readonly label: string;
    readonly description?: string;
    readonly uri: Uri;
}

export type ProjectCreatorPick =
    | { readonly kind: 'creator'; readonly creator: PythonProjectCreator }
    | { readonly kind: 'discovered'; readonly uris: readonly Uri[] };

interface ProjectAdditionQuickPickItem extends QuickPickItem {
    pickId?: 'discovered' | 'discovered-all' | 'existing' | 'new';
    uri?: Uri;
}

export async function pickCreator(
    creators: PythonProjectCreator[],
    discovered: readonly DiscoveredProjectOption[] = [],
): Promise<ProjectCreatorPick | undefined> {
    if (creators.length === 0 && discovered.length === 0) {
        return;
    }

    // A lone non-discovery creator still skips the menu. Auto Find is not that creator:
    // with nothing to add it would only report that no projects were found.
    if (discovered.length === 0 && creators.length === 1) {
        if (creators[0].name === 'autoProjects') {
            return undefined;
        }
        return { kind: 'creator', creator: creators[0] };
    }

    const existingProjectsCreator = creators.find((c) => c.name === 'existingProjects');
    const otherCreators = creators.filter((c) => c.name !== 'autoProjects' && c.name !== 'existingProjects');

    // List discoveries in this quick pick. Omit Auto Find entirely: when the search
    // finds nothing, that action only produced a "No projects found" error.
    const items: ProjectAdditionQuickPickItem[] = [];
    if (discovered.length > 0) {
        items.push({
            label: ProjectCreatorString.discoveredProjects,
            kind: QuickPickItemKind.Separator,
        });
        for (const project of discovered) {
            items.push({
                label: project.label,
                description: project.description,
                pickId: 'discovered',
                uri: project.uri,
            });
        }
        if (discovered.length > 1) {
            items.push({
                label: ProjectCreatorString.addAllDiscoveredProjects,
                description: ProjectCreatorString.addAllDiscoveredProjectsDescription,
                pickId: 'discovered-all',
            });
        }
    }

    const actions: ProjectAdditionQuickPickItem[] = [];
    if (existingProjectsCreator) {
        actions.push({
            label: 'Select Existing',
            description: existingProjectsCreator.description ?? 'Select existing Python projects',
            pickId: 'existing',
        });
    }
    if (otherCreators.length > 0) {
        actions.push({
            label: 'Create New',
            description: 'Create a Python project from a template',
            pickId: 'new',
        });
    }
    if (discovered.length > 0 && actions.length > 0) {
        items.push({ label: '', kind: QuickPickItemKind.Separator });
    }
    items.push(...actions);

    if (!items.some((item) => item.kind !== QuickPickItemKind.Separator)) {
        return undefined;
    }

    const selected = await showQuickPickWithButtons(items, {
        placeHolder:
            discovered.length > 0 ? ProjectCreatorString.selectProject : Pickers.Managers.selectProjectCreator,
        ignoreFocusOut: true,
        showBackButton: true,
        matchOnDescription: discovered.length > 0,
    });

    if (!selected) {
        return undefined;
    }

    const selectedItem = Array.isArray(selected) ? selected[0] : selected;
    if (!selectedItem || selectedItem.kind === QuickPickItemKind.Separator) {
        return undefined;
    }
    switch (selectedItem.pickId) {
        case 'discovered':
            return selectedItem.uri ? { kind: 'discovered', uris: [selectedItem.uri] } : undefined;
        case 'discovered-all':
            return { kind: 'discovered', uris: discovered.map((project) => project.uri) };
        case 'existing':
            return existingProjectsCreator ? { kind: 'creator', creator: existingProjectsCreator } : undefined;
        case 'new': {
            const creator = await newProjectSelection(creators, discovered);
            return creator ? { kind: 'creator', creator } : undefined;
        }
        default:
            return undefined;
    }
}

export async function newProjectSelection(
    creators: PythonProjectCreator[],
    discovered: readonly DiscoveredProjectOption[] = [],
): Promise<PythonProjectCreator | undefined> {
    const otherCreators = creators.filter((c) => c.name !== 'autoProjects' && c.name !== 'existingProjects');

    // Show second level menu for other creators
    if (otherCreators.length === 0) {
        return undefined;
    }
    const newItems: (QuickPickItem & { c: PythonProjectCreator })[] = otherCreators.map((c) => ({
        label: c.displayName ?? c.name,
        description: c.description,
        c: c,
    }));
    try {
        const newSelected = await showQuickPickWithButtons(newItems, {
            placeHolder: 'Select project type for new project',
            ignoreFocusOut: true,
            showBackButton: true,
        });

        if (!newSelected) {
            // User cancelled the picker
            return undefined;
        }
        // Handle back button
        if (
            !Array.isArray(newSelected) &&
            (newSelected.kind === QuickPickItemKind.Separator || ('back' in newSelected && newSelected.back === true))
        ) {
            // User pressed the back button, re-show the first menu
            const next = await pickCreator(creators, discovered);
            return next?.kind === 'creator' ? next.creator : undefined;
        }

        // Handle case where newSelected could be an array (should not happen, but for type safety)
        const selectedCreator = Array.isArray(newSelected) ? newSelected[0] : newSelected;
        return selectedCreator?.c;
    } catch (ex) {
        if (ex === QuickInputButtons.Back) {
            await executeCommand('python-envs.addPythonProject');
        }
    }
}
