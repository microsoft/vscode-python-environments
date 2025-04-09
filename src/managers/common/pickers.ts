import { QuickInputButtons, QuickPickItem, QuickPickItemButtonEvent, QuickPickItemKind, ThemeIcon, Uri } from 'vscode';
import { Common, PackageManagement } from '../../common/localize';
import { launchBrowser } from '../../common/env.apis';
import { showInputBoxWithButtons, showQuickPickWithButtons, showTextDocument } from '../../common/window.apis';

const OPEN_BROWSER_BUTTON = {
    iconPath: new ThemeIcon('globe'),
    tooltip: Common.openInBrowser,
};

const OPEN_EDITOR_BUTTON = {
    iconPath: new ThemeIcon('go-to-file'),
    tooltip: Common.openInEditor,
};

const EDIT_ARGUMENTS_BUTTON = {
    iconPath: new ThemeIcon('pencil'),
    tooltip: PackageManagement.editArguments,
};

export interface Installable {
    /**
     * The name of the package, requirements, lock files, or step name.
     */
    readonly name: string;

    /**
     * The name of the package, requirements, pyproject.toml or any other project file, etc.
     */
    readonly displayName: string;

    /**
     * Arguments passed to the package manager to install the package.
     *
     * @example
     *  ['debugpy==1.8.7'] for `pip install debugpy==1.8.7`.
     *  ['--pre', 'debugpy'] for `pip install --pre debugpy`.
     *  ['-r', 'requirements.txt'] for `pip install -r requirements.txt`.
     */
    readonly args?: string[];

    /**
     * Installable group name, this will be used to group installable items in the UI.
     *
     * @example
     *  `Requirements` for any requirements file.
     *  `Packages` for any package.
     */
    readonly group?: string;

    /**
     * Description about the installable item. This can also be path to the requirements,
     * version of the package, or any other project file path.
     */
    readonly description?: string;

    /**
     * External Uri to the package on pypi or docs.
     * @example
     *  https://pypi.org/project/debugpy/ for `debugpy`.
     */
    readonly uri?: Uri;
}

function handleItemButton(uri?: Uri) {
    if (uri) {
        if (uri.scheme.toLowerCase().startsWith('http')) {
            launchBrowser(uri);
        } else {
            showTextDocument(uri);
        }
    }
}

interface PackageQuickPickItem extends QuickPickItem {
    id: string;
    uri?: Uri;
    args?: string[];
}

function getDetail(i: Installable): string | undefined {
    if (i.args && i.args.length > 0) {
        if (i.args.length === 1 && i.args[0] === i.name) {
            return undefined;
        }
        return i.args.join(' ');
    }
    return undefined;
}

function installableToQuickPickItem(i: Installable): PackageQuickPickItem {
    const detail = i.description ? getDetail(i) : undefined;
    const description = i.description ? i.description : getDetail(i);
    const buttons = i.uri
        ? i.uri.scheme.startsWith('http')
            ? [OPEN_BROWSER_BUTTON]
            : [OPEN_EDITOR_BUTTON]
        : undefined;
    return {
        label: i.displayName,
        detail,
        description,
        buttons,
        uri: i.uri,
        args: i.args,
        id: i.name,
    };
}

async function enterPackageManually(filler?: string): Promise<string[] | undefined> {
    const input = await showInputBoxWithButtons({
        placeHolder: PackageManagement.enterPackagesPlaceHolder,
        value: filler,
        ignoreFocusOut: true,
        showBackButton: true,
    });
    return input?.split(' ');
}

interface GroupingResult {
    items: QuickPickItem[];
    installedItems: PackageQuickPickItem[];
}

function groupByInstalled(items: PackageQuickPickItem[], installed?: string[]): GroupingResult {
    const installedItems: PackageQuickPickItem[] = [];
    const result: PackageQuickPickItem[] = [];
    items.forEach((i) => {
        if (installed?.find((p) => i.id === p)) {
            installedItems.push(i);
        } else {
            result.push(i);
        }
    });
    const installedSeparator: QuickPickItem = {
        label: PackageManagement.installed,
        kind: QuickPickItemKind.Separator,
    };
    const commonPackages: QuickPickItem = {
        label: PackageManagement.commonPackages,
        kind: QuickPickItemKind.Separator,
    };
    return {
        items: [installedSeparator, ...installedItems, commonPackages, ...result],
        installedItems,
    };
}

export interface CommonPackagesResult {
    install: string[];
    uninstall: string[];
}

function selectionsToResult(selections: string[], installed: string[]): CommonPackagesResult {
    const install: string[] = selections;
    const uninstall: string[] = [];
    installed.forEach((i) => {
        if (!selections.find((s) => i === s)) {
            uninstall.push(i);
        }
    });
    return {
        install,
        uninstall,
    };
}

export async function selectFromCommonPackagesToInstall(
    common: Installable[],
    installed: string[],
    preSelected?: PackageQuickPickItem[] | undefined,
): Promise<CommonPackagesResult | undefined> {
    const { installedItems, items } = groupByInstalled(common.map(installableToQuickPickItem), installed);
    const preSelectedItems = [...installedItems, ...(preSelected ?? [])];
    let selected: PackageQuickPickItem | PackageQuickPickItem[] | undefined;
    try {
        selected = await showQuickPickWithButtons(
            items as PackageQuickPickItem[],
            {
                placeHolder: PackageManagement.selectPackagesToInstall,
                ignoreFocusOut: true,
                canPickMany: true,
                showBackButton: true,
                buttons: [EDIT_ARGUMENTS_BUTTON],
                selected: preSelectedItems,
            },
            undefined,
            (e: QuickPickItemButtonEvent<PackageQuickPickItem>) => {
                handleItemButton(e.item.uri);
            },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (ex: any) {
        if (ex === QuickInputButtons.Back) {
            throw ex;
        } else if (ex.button === EDIT_ARGUMENTS_BUTTON && ex.item) {
            const parts: PackageQuickPickItem[] = Array.isArray(ex.item) ? ex.item : [ex.item];
            selected = [
                {
                    id: PackageManagement.enterPackageNames,
                    label: PackageManagement.enterPackageNames,
                    alwaysShow: true,
                },
                ...parts,
            ];
        }
    }

    if (selected && Array.isArray(selected)) {
        if (selected.find((s) => s.label === PackageManagement.enterPackageNames)) {
            const filler = selected
                .filter((s) => s.label !== PackageManagement.enterPackageNames)
                .map((s) => s.id)
                .join(' ');
            try {
                const selections = await enterPackageManually(filler);
                if (selections) {
                    return selectionsToResult(selections, installed);
                }
                return undefined;
            } catch (ex) {
                if (ex === QuickInputButtons.Back) {
                    return selectFromCommonPackagesToInstall(common, installed, selected);
                }
                return undefined;
            }
        } else {
            return selectionsToResult(
                selected.map((s) => s.id),
                installed,
            );
        }
    }
}

function getGroupedItems(items: Installable[]): PackageQuickPickItem[] {
    const groups = new Map<string, Installable[]>();
    const workspaceInstallable: Installable[] = [];

    items.forEach((i) => {
        if (i.group) {
            let group = groups.get(i.group);
            if (!group) {
                group = [];
                groups.set(i.group, group);
            }
            group.push(i);
        } else {
            workspaceInstallable.push(i);
        }
    });

    const result: PackageQuickPickItem[] = [];
    groups.forEach((group, key) => {
        result.push({
            id: key,
            label: key,
            kind: QuickPickItemKind.Separator,
        });
        result.push(...group.map(installableToQuickPickItem));
    });

    if (workspaceInstallable.length > 0) {
        result.push({
            id: PackageManagement.workspaceDependencies,
            label: PackageManagement.workspaceDependencies,
            kind: QuickPickItemKind.Separator,
        });
        result.push(...workspaceInstallable.map(installableToQuickPickItem));
    }

    return result;
}

export async function selectFromInstallableToInstall(
    installable: Installable[],
    preSelected?: PackageQuickPickItem[],
): Promise<string[] | undefined> {
    const items: PackageQuickPickItem[] = [];

    if (installable && installable.length > 0) {
        items.push(...getGroupedItems(installable));
    } else {
        return undefined;
    }

    let preSelectedItems = items
        .filter((i) => i.kind !== QuickPickItemKind.Separator)
        .filter((i) =>
            preSelected?.find((s) => s.id === i.id && s.description === i.description && s.detail === i.detail),
        );
    const selected = await showQuickPickWithButtons(
        items,
        {
            placeHolder: PackageManagement.selectPackagesToInstall,
            ignoreFocusOut: true,
            canPickMany: true,
            showBackButton: true,
            selected: preSelectedItems,
        },
        undefined,
        (e: QuickPickItemButtonEvent<PackageQuickPickItem>) => {
            handleItemButton(e.item.uri);
        },
    );

    if (selected) {
        if (Array.isArray(selected)) {
            return selected.flatMap((s) => s.args ?? []);
        } else {
            return selected.args ?? [];
        }
    }
    return undefined;
}
