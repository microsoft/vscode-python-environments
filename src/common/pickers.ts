import {
    QuickInputButtons,
    QuickPickItem,
    QuickPickItemButtonEvent,
    QuickPickItemKind,
    ThemeIcon,
    Uri,
    window,
} from 'vscode';
import {
    GetEnvironmentsScope,
    IconPath,
    Installable,
    Package,
    PythonEnvironment,
    PythonProject,
    PythonProjectCreator,
} from '../api';
import * as fs from 'fs-extra';
import * as path from 'path';
import { InternalEnvironmentManager, InternalPackageManager } from '../internal.api';
import { Common, PackageManagement } from './localize';
import { EXTENSION_ROOT_DIR } from './constants';
import { showInputBoxWithButtons, showQuickPickWithButtons, showTextDocument } from './window.apis';
import { launchBrowser } from './env.apis';
import { traceWarn } from './logging';

export async function pickProject(pws: ReadonlyArray<PythonProject>): Promise<PythonProject | undefined> {
    if (pws.length > 1) {
        const items = pws.map((pw) => ({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            pw: pw,
        }));
        const item = await window.showQuickPick(items, {
            placeHolder: 'Select a project, folder or script',
            ignoreFocusOut: true,
        });
        if (item) {
            return item.pw;
        }
    } else if (pws.length === 1) {
        return pws[0];
    }
    return undefined;
}

interface ProjectQuickPickItem extends QuickPickItem {
    project: PythonProject;
}
export async function pickProjectMany(projects: ReadonlyArray<PythonProject>): Promise<PythonProject[] | undefined> {
    if (projects.length > 1) {
        const items: ProjectQuickPickItem[] = projects.map((pw) => ({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            project: pw,
        }));
        const item: ProjectQuickPickItem[] | undefined = await window.showQuickPick(items, {
            placeHolder: 'Select a project, folder or script',
            ignoreFocusOut: true,
            canPickMany: true,
        });
        if (item) {
            return item.map((p) => p.project);
        }
    } else if (projects.length === 1) {
        return [...projects];
    }
    return undefined;
}

export async function pickEnvironmentManager(
    managers: InternalEnvironmentManager[],
    defaultMgr?: InternalEnvironmentManager,
): Promise<string | undefined> {
    const items = managers.map((m) => ({
        label: defaultMgr?.id === m.id ? `${m.displayName} (${Common.recommended})` : m.displayName,
        description: m.description,
        id: m.id,
    }));
    const item = await window.showQuickPick(items, {
        placeHolder: 'Select an environment manager',
        ignoreFocusOut: true,
    });
    return item?.id;
}

export async function pickPackageManager(
    managers: InternalPackageManager[],
    defaultMgr?: InternalPackageManager,
): Promise<string | undefined> {
    const items = managers.map((m) => ({
        label: defaultMgr?.id === m.id ? `${m.displayName} (${Common.recommended})` : m.displayName,
        description: m.description,
        id: m.id,
    }));

    const item = await window.showQuickPick(items, {
        placeHolder: 'Select a package manager',
        ignoreFocusOut: true,
    });
    return item?.id;
}

type QuickPickIcon =
    | Uri
    | {
          /**
           * The icon path for the light theme.
           */
          light: Uri;
          /**
           * The icon path for the dark theme.
           */
          dark: Uri;
      }
    | ThemeIcon
    | undefined;

function getIconPath(i: IconPath | undefined): QuickPickIcon {
    if (i === undefined || i instanceof Uri || i instanceof ThemeIcon) {
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

export interface SelectionResult {
    selected: PythonEnvironment;
    manager: InternalEnvironmentManager;
}

export async function pickEnvironment(
    managers: InternalEnvironmentManager[],
    scope: GetEnvironmentsScope,
    recommended?: SelectionResult,
): Promise<SelectionResult | undefined> {
    const items: (QuickPickItem | (QuickPickItem & { e: SelectionResult }))[] = [];

    if (recommended) {
        items.push(
            {
                label: Common.recommended,
                kind: QuickPickItemKind.Separator,
            },
            {
                label: recommended.selected.displayName,
                description: recommended.selected.description,
                e: recommended,
                iconPath: getIconPath(recommended.selected.iconPath),
            },
        );
    }

    for (const manager of managers) {
        items.push({
            label: manager.displayName,
            kind: QuickPickItemKind.Separator,
        });
        const envs = await manager.getEnvironments(scope);
        items.push(
            ...envs.map((e) => {
                return {
                    label: e.displayName ?? e.name,
                    description: e.description,
                    e: { selected: e, manager: manager },
                    iconPath: getIconPath(e.iconPath),
                };
            }),
        );
    }
    const selected = await window.showQuickPick(items, {
        placeHolder: `Select a Python Environment`,
        ignoreFocusOut: true,
    });
    return (selected as { e: SelectionResult })?.e;
}

export async function pickEnvironmentFrom(environments: PythonEnvironment[]): Promise<PythonEnvironment | undefined> {
    const items = environments.map((e) => ({
        label: e.displayName ?? e.name,
        description: e.description,
        e: e,
        iconPath: getIconPath(e.iconPath),
    }));
    const selected = await window.showQuickPick(items, {
        placeHolder: 'Select Python Environment',
        ignoreFocusOut: true,
    });
    return (selected as { e: PythonEnvironment })?.e;
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
    const selected = await window.showQuickPick(items, {
        placeHolder: 'Select a project creator',
        ignoreFocusOut: true,
    });
    return (selected as { c: PythonProjectCreator })?.c;
}

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
    const selected = await window.showQuickPick(items, {
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

async function getWorkspacePackages(
    packageManager: InternalPackageManager,
    environment: PythonEnvironment,
    preSelected?: PackageQuickPickItem[] | undefined,
): Promise<string[] | undefined> {
    const items: PackageQuickPickItem[] = [];

    let installable = await packageManager?.getInstallable(environment);
    if (installable && installable.length > 0) {
        items.push(...getGroupedItems(installable));
    } else {
        traceWarn(`No installable packages found for ${packageManager.id}: ${environment.environmentPath.fsPath}`);
        installable = await getCommonPackages();
        items.push(
            {
                label: PackageManagement.commonPackages,
                kind: QuickPickItemKind.Separator,
            },
            ...installable.map(installableToQuickPickItem),
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
                    return getWorkspacePackages(packageManager, environment, selected);
                }
                return undefined;
            }
        } else {
            return selected.flatMap((s) => s.args ?? []);
        }
    }
}

export async function getCommonPackagesToInstall(
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

export async function getPackagesToInstall(
    packageManager: InternalPackageManager,
    environment: PythonEnvironment,
): Promise<string[] | undefined> {
    const packageType = packageManager.supportsGetInstallable
        ? await getPackageType()
        : PackageManagement.commonPackages;

    if (packageType === PackageManagement.workspaceDependencies) {
        try {
            const result = await getWorkspacePackages(packageManager, environment);
            return result;
        } catch (ex) {
            if (packageManager.supportsGetInstallable && ex === QuickInputButtons.Back) {
                return getPackagesToInstall(packageManager, environment);
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
                return getPackagesToInstall(packageManager, environment);
            }
            if (ex === QuickInputButtons.Back) {
                throw ex;
            }
            return undefined;
        }
    }

    return undefined;
}

export async function getPackagesToUninstall(packages: Package[]): Promise<Package[] | undefined> {
    const items = packages.map((p) => ({
        label: p.name,
        description: p.version,
        p: p,
    }));
    const selected = await window.showQuickPick(items, {
        placeHolder: PackageManagement.selectPackagesToUninstall,
        ignoreFocusOut: true,
        canPickMany: true,
    });
    return selected?.map((s) => s.p);
}
