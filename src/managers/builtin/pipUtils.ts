import * as fse from 'fs-extra';
import * as path from 'path';
import * as tomljs from '@iarna/toml';
import {
    LogOutputChannel,
    ProgressLocation,
    QuickInputButtons,
    QuickPickItem,
    QuickPickItemButtonEvent,
    QuickPickItemKind,
    ThemeIcon,
    Uri,
} from 'vscode';
import {
    showInputBoxWithButtons,
    showQuickPick,
    showQuickPickWithButtons,
    showTextDocument,
    withProgress,
} from '../../common/window.apis';
import { Common, PackageManagement, VenvManagerStrings } from '../../common/localize';
import { Package, PythonEnvironmentApi, PythonProject } from '../../api';
import { findFiles } from '../../common/workspace.apis';
import { launchBrowser } from '../../common/env.apis';
import { EXTENSION_ROOT_DIR } from '../../common/constants';

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

interface Installable {
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

function tomlParse(content: string, log?: LogOutputChannel): tomljs.JsonMap {
    try {
        return tomljs.parse(content);
    } catch (err) {
        log?.error('Failed to parse `pyproject.toml`:', err);
    }
    return {};
}

function isPipInstallableToml(toml: tomljs.JsonMap): boolean {
    return toml['build-system'] !== undefined && toml.project !== undefined;
}

function getTomlInstallable(toml: tomljs.JsonMap, tomlPath: Uri): Installable[] {
    const extras: Installable[] = [];

    if (isPipInstallableToml(toml)) {
        const name = path.basename(tomlPath.fsPath);
        extras.push({
            name,
            displayName: name,
            description: VenvManagerStrings.installEditable,
            group: 'TOML',
            args: ['-e', path.dirname(tomlPath.fsPath)],
            uri: tomlPath,
        });
    }

    if (toml.project && (toml.project as tomljs.JsonMap)['optional-dependencies']) {
        const deps = (toml.project as tomljs.JsonMap)['optional-dependencies'];
        for (const key of Object.keys(deps)) {
            extras.push({
                name: key,
                displayName: key,
                group: 'TOML',
                args: ['-e', `.[${key}]`],
                uri: tomlPath,
            });
        }
    }
    return extras;
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

async function selectPackagesToInstall(
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

async function getCommonPackages(): Promise<Installable[]> {
    const pipData = path.join(EXTENSION_ROOT_DIR, 'files', 'common_packages.txt');
    const data = await fse.readFile(pipData, { encoding: 'utf-8' });
    const packages = data.split(/\r?\n/).filter((l) => l.trim().length > 0);

    return packages.map((p) => {
        return {
            name: p,
            displayName: p,
            uri: Uri.parse(`https://pypi.org/project/${p}`),
        };
    });
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

async function getCommonPipPackagesToInstall(
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
                const result = await enterPackageManually(filler);
                return result;
            } catch (ex) {
                if (ex === QuickInputButtons.Back) {
                    return getCommonPipPackagesToInstall(selected);
                }
                return undefined;
            }
        } else {
            return selected.map((s) => s.id);
        }
    }
}

export async function getWorkspacePackagesToInstall(
    api: PythonEnvironmentApi,
    project?: PythonProject[],
): Promise<string[] | undefined> {
    const installable = await getProjectInstallable(api, project);

    if (installable && installable.length > 0) {
        return selectPackagesToInstall(installable);
    }
    return getCommonPipPackagesToInstall();
}

export async function getProjectInstallable(
    api: PythonEnvironmentApi,
    projects?: PythonProject[],
): Promise<Installable[]> {
    if (!projects) {
        return [];
    }
    const exclude = '**/{.venv*,.git,.nox,.tox,.conda,site-packages,__pypackages__}/**';
    const installable: Installable[] = [];
    await withProgress(
        {
            location: ProgressLocation.Window,
            title: VenvManagerStrings.searchingDependencies,
        },
        async (_progress, token) => {
            const results: Uri[] = (
                await Promise.all([
                    findFiles('**/*requirements*.txt', exclude, undefined, token),
                    findFiles('**/requirements/*.txt', exclude, undefined, token),
                    findFiles('**/pyproject.toml', exclude, undefined, token),
                ])
            ).flat();

            const fsPaths = projects.map((p) => p.uri.fsPath);
            const filtered = results
                .filter((uri) => {
                    const p = api.getPythonProject(uri)?.uri.fsPath;
                    return p && fsPaths.includes(p);
                })
                .sort();

            await Promise.all(
                filtered.map(async (uri) => {
                    if (uri.fsPath.endsWith('.toml')) {
                        const toml = tomlParse(await fse.readFile(uri.fsPath, 'utf-8'));
                        installable.push(...getTomlInstallable(toml, uri));
                    } else {
                        const name = path.basename(uri.fsPath);
                        installable.push({
                            name,
                            uri,
                            displayName: name,
                            group: 'Requirements',
                            args: ['-r', uri.fsPath],
                        });
                    }
                }),
            );
        },
    );
    return installable;
}

export async function getPackagesToUninstall(packages: Package[]): Promise<Package[] | undefined> {
    const items = packages.map((p) => ({
        label: p.name,
        description: p.version,
        p,
    }));
    const selected = await showQuickPick(items, {
        placeHolder: PackageManagement.selectPackagesToUninstall,
        ignoreFocusOut: true,
        canPickMany: true,
    });
    return Array.isArray(selected) ? selected?.map((s) => s.p) : undefined;
}
