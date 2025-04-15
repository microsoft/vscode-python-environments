import { QuickPickItem, QuickPickItemKind } from 'vscode';
import { PythonProjectCreator } from '../../api';
import { InternalEnvironmentManager, InternalPackageManager } from '../../internal.api';
import { Common, Pickers } from '../localize';
import { showQuickPickWithButtons, showQuickPick } from '../window.apis';

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
): Promise<string | undefined> {
    if (managers.length === 0) {
        return;
    }

    if (managers.length === 1) {
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
    const item = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Managers.selectEnvironmentManager,
        ignoreFocusOut: true,
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

export async function pickCreator(creators: PythonProjectCreator[]): Promise<PythonProjectCreator | undefined> {
    if (creators.length === 0) {
        return;
    }

    if (creators.length === 1) {
        return creators[0];
    }

    const items: (QuickPickItem & { c: PythonProjectCreator })[] = creators.map((c) => ({
        label: c.displayName ?? c.name,
        description: c.description,
        c: c,
    }));
    const selected = await showQuickPick(items, {
        placeHolder: Pickers.Managers.selectProjectCreator,
        ignoreFocusOut: true,
    });
    return (selected as { c: PythonProjectCreator })?.c;
}
