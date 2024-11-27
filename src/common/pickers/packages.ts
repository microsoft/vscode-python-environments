import * as path from 'path';
import * as fs from 'fs-extra';
import { Uri, ThemeIcon, QuickPickItem, QuickPickItemKind, QuickPickItemButtonEvent, QuickInputButtons } from 'vscode';
import { Installable, PythonEnvironment, Package } from '../../api';
import { InternalPackageManager } from '../../internal.api';
import { EXTENSION_ROOT_DIR } from '../constants';
import { launchBrowser } from '../env.apis';
import { Common, PackageManagement } from '../localize';
import { traceWarn } from '../logging';
import { showQuickPick, showInputBoxWithButtons, showTextDocument, showQuickPickWithButtons } from '../window.apis';

export async function pickPackageOptions(): Promise<string | undefined> {
    const items = [
        {
            label: Common.install,
            description: 'Install packages',
        },
        {
            label: Common.uninstall,
            description: 'Uninstall packages',
        },
    ];
    const selected = await showQuickPick(items, {
        placeHolder: 'Select an option',
        ignoreFocusOut: true,
    });
    return selected?.label;
}

export async function enterPackageManually(filler?: string): Promise<string[] | undefined> {
    const input = await showInputBoxWithButtons({
        placeHolder: PackageManagement.enterPackagesPlaceHolder,
        value: filler,
        ignoreFocusOut: true,
        showBackButton: true,
    });
    return input?.split(' ');
}

async function getCommonPackages(): Promise<Installable[]> {
    const pipData = path.join(EXTENSION_ROOT_DIR, 'files', 'common_packages.txt');
    const data = await fs.readFile(pipData, { encoding: 'utf-8' });
    const packages = data.split(/\r?\n/).filter((l) => l.trim().length > 0);

    return packages.map((p) => {
        return {
            displayName: p,
            args: [p],
            uri: Uri.parse(`https://pypi.org/project/${p}`),
        };
    });
}

export const OPEN_BROWSER_BUTTON = {
    iconPath: new ThemeIcon('globe'),
    tooltip: Common.openInBrowser,
};

export const OPEN_EDITOR_BUTTON = {
    iconPath: new ThemeIcon('go-to-file'),
    tooltip: Common.openInEditor,
};

export const EDIT_ARGUMENTS_BUTTON = {
    iconPath: new ThemeIcon('pencil'),
    tooltip: PackageManagement.editArguments,
};

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
    uri?: Uri;
    args?: string[];
}

function getDetail(i: Installable): string | undefined {
    if (i.args && i.args.length > 0) {
        if (i.args.length === 1 && i.args[0] === i.displayName) {
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
    };
}

async function getPackageType(): Promise<string | undefined> {
    const items: QuickPickItem[] = [
        {
            label: PackageManagement.workspaceDependencies,
            description: PackageManagement.workspaceDependenciesDescription,
            alwaysShow: true,
            iconPath: new ThemeIcon('folder'),
        },
        {
            label: PackageManagement.commonPackages,
            description: PackageManagement.commonPackagesDescription,
            alwaysShow: true,
            iconPath: new ThemeIcon('search'),
        },
    ];
    const selected = (await showQuickPickWithButtons(items, {
        placeHolder: PackageManagement.selectPackagesToInstall,
        showBackButton: true,
        ignoreFocusOut: true,
    })) as QuickPickItem;

    return selected?.label;
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
            label: key,
            kind: QuickPickItemKind.Separator,
        });
        result.push(...group.map(installableToQuickPickItem));
    });

    if (workspaceInstallable.length > 0) {
        result.push({
            label: PackageManagement.workspaceDependencies,
            kind: QuickPickItemKind.Separator,
        });
        result.push(...workspaceInstallable.map(installableToQuickPickItem));
    }

    return result;
}

async function getInstallables(packageManager: InternalPackageManager, environment: PythonEnvironment) {
    const installable = await packageManager?.getInstallable(environment);
    if (installable && installable.length === 0) {
        traceWarn(`No installable packages found for ${packageManager.id}: ${environment.environmentPath.fsPath}`);
    }
    return installable;
}

async function getWorkspacePackages(
    installable: Installable[] | undefined,
    preSelected?: PackageQuickPickItem[] | undefined,
): Promise<string[] | undefined> {
    const items: PackageQuickPickItem[] = [];

    if (installable && installable.length > 0) {
        items.push(...getGroupedItems(installable));
    } else {
        const common = await getCommonPackages();
        items.push(
            {
                label: PackageManagement.commonPackages,
                kind: QuickPickItemKind.Separator,
            },
            ...common.map(installableToQuickPickItem),
        );
    }

    let preSelectedItems = items
        .filter((i) => i.kind !== QuickPickItemKind.Separator)
        .filter((i) =>
            preSelected?.find((s) => s.label === i.label && s.description === i.description && s.detail === i.detail),
        );
    let selected: PackageQuickPickItem | PackageQuickPickItem[] | undefined;
    try {
        selected = await showQuickPickWithButtons(
            items,
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
                .flatMap((s) => s.args ?? [])
                .join(' ');
            try {
                const result = await enterPackageManually(filler);
                return result;
            } catch (ex) {
                if (ex === QuickInputButtons.Back) {
                    return getWorkspacePackages(installable, selected);
                }
                return undefined;
            }
        } else {
            return selected.flatMap((s) => s.args ?? []);
        }
    }
}

async function getCommonPackagesToInstall(
    preSelected?: PackageQuickPickItem[] | undefined,
): Promise<string[] | undefined> {
    const common = await getCommonPackages();

    const items: PackageQuickPickItem[] = common.map(installableToQuickPickItem);
    const preSelectedItems = items
        .filter((i) => i.kind !== QuickPickItemKind.Separator)
        .filter((i) =>
            preSelected?.find((s) => s.label === i.label && s.description === i.description && s.detail === i.detail),
        );

    let selected: PackageQuickPickItem | PackageQuickPickItem[] | undefined;
    try {
        selected = await showQuickPickWithButtons(
            items,
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
                .map((s) => s.label)
                .join(' ');
            try {
                const result = await enterPackageManually(filler);
                return result;
            } catch (ex) {
                if (ex === QuickInputButtons.Back) {
                    return getCommonPackagesToInstall(selected);
                }
                return undefined;
            }
        } else {
            return selected.map((s) => s.label);
        }
    }
}

export async function getPackagesToInstallFromPackageManager(
    packageManager: InternalPackageManager,
    environment: PythonEnvironment,
): Promise<string[] | undefined> {
    const packageType = packageManager.supportsGetInstallable
        ? await getPackageType()
        : PackageManagement.commonPackages;

    if (packageType === PackageManagement.workspaceDependencies) {
        try {
            const installable = await getInstallables(packageManager, environment);
            const result = await getWorkspacePackages(installable);
            return result;
        } catch (ex) {
            if (packageManager.supportsGetInstallable && ex === QuickInputButtons.Back) {
                return getPackagesToInstallFromPackageManager(packageManager, environment);
            }
            if (ex === QuickInputButtons.Back) {
                throw ex;
            }
            return undefined;
        }
    }

    if (packageType === PackageManagement.commonPackages) {
        try {
            const result = await getCommonPackagesToInstall();
            return result;
        } catch (ex) {
            if (packageManager.supportsGetInstallable && ex === QuickInputButtons.Back) {
                return getPackagesToInstallFromPackageManager(packageManager, environment);
            }
            if (ex === QuickInputButtons.Back) {
                throw ex;
            }
            return undefined;
        }
    }

    return undefined;
}

export async function getPackagesToInstallFromInstallable(installable: Installable[]): Promise<string[] | undefined> {
    if (installable.length === 0) {
        return undefined;
    }
    return getWorkspacePackages(installable);
}

export async function getPackagesToUninstall(packages: Package[]): Promise<Package[] | undefined> {
    const items = packages.map((p) => ({
        label: p.name,
        description: p.version,
        p: p,
    }));
    const selected = await showQuickPick(items, {
        placeHolder: PackageManagement.selectPackagesToUninstall,
        ignoreFocusOut: true,
        canPickMany: true,
    });
    return Array.isArray(selected) ? selected?.map((s) => s.p) : undefined;
}
