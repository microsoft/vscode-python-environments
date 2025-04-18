import * as fse from 'fs-extra';
import * as path from 'path';
import * as tomljs from '@iarna/toml';
import { LogOutputChannel, ProgressLocation, QuickInputButtons, Uri } from 'vscode';
import { showQuickPickWithButtons, withProgress } from '../../common/window.apis';
import { PackageManagement, Pickers, VenvManagerStrings } from '../../common/localize';
import { PackageManagementOptions, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { findFiles } from '../../common/workspace.apis';
import { EXTENSION_ROOT_DIR } from '../../common/constants';
import { selectFromCommonPackagesToInstall, selectFromInstallableToInstall } from '../common/pickers';
import { traceInfo } from '../../common/logging';
import { Installable, mergePackages } from '../common/utils';

async function tomlParse(fsPath: string, log?: LogOutputChannel): Promise<tomljs.JsonMap> {
    try {
        const content = await fse.readFile(fsPath, 'utf-8');
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

async function getCommonPackages(): Promise<Installable[]> {
    try {
        const pipData = path.join(EXTENSION_ROOT_DIR, 'files', 'common_pip_packages.json');
        const data = await fse.readFile(pipData, { encoding: 'utf-8' });
        const packages = JSON.parse(data) as { name: string; uri: string }[];

        return packages.map((p) => {
            return {
                name: p.name,
                displayName: p.name,
                uri: Uri.parse(p.uri),
            };
        });
    } catch {
        return [];
    }
}

async function selectWorkspaceOrCommon(
    installable: Installable[],
    common: Installable[],
    showSkipOption: boolean,
    installed: string[],
): Promise<PipPackages | undefined> {
    if (installable.length === 0 && common.length === 0) {
        return undefined;
    }

    const items = [];
    if (installable.length > 0) {
        items.push({
            label: PackageManagement.workspaceDependencies,
            description: PackageManagement.workspaceDependenciesDescription,
        });
    }

    if (common.length > 0) {
        items.push({
            label: PackageManagement.searchCommonPackages,
            description: PackageManagement.searchCommonPackagesDescription,
        });
    }

    if (showSkipOption && items.length > 0) {
        items.push({ label: PackageManagement.skipPackageInstallation });
    }

    const selected =
        items.length === 1
            ? items[0]
            : await showQuickPickWithButtons(items, {
                  placeHolder: Pickers.Packages.selectOption,
                  ignoreFocusOut: true,
                  showBackButton: true,
                  matchOnDescription: false,
                  matchOnDetail: false,
              });

    if (selected && !Array.isArray(selected)) {
        try {
            if (selected.label === PackageManagement.workspaceDependencies) {
                const installArgs = await selectFromInstallableToInstall(installable);
                return { install: installArgs ?? [], uninstall: [] };
            } else if (selected.label === PackageManagement.searchCommonPackages) {
                return await selectFromCommonPackagesToInstall(common, installed);
            } else {
                traceInfo('Package Installer: user selected skip package installation');
                return undefined;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (ex: any) {
            if (ex === QuickInputButtons.Back) {
                return selectWorkspaceOrCommon(installable, common, showSkipOption, installed);
            }
        }
    }
    return undefined;
}

export interface PipPackages {
    install: string[];
    uninstall: string[];
}

export async function getWorkspacePackagesToInstall(
    api: PythonEnvironmentApi,
    options: PackageManagementOptions,
    project?: PythonProject[],
    environment?: PythonEnvironment,
): Promise<PipPackages | undefined> {
    const installable = (await getProjectInstallable(api, project)) ?? [];
    let common = await getCommonPackages();
    let installed: string[] | undefined;
    if (environment) {
        installed = (await api.getPackages(environment))?.map((pkg) => pkg.name);
        common = mergePackages(common, installed ?? []);
    }
    return selectWorkspaceOrCommon(installable, common, !!options.showSkipOption, installed ?? []);
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
                        const toml = await tomlParse(uri.fsPath);
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

export function isPipInstallCommand(command: string): boolean {
    // Regex to match pip install commands, capturing variations like:
    // pip install package
    // python -m pip install package
    // pip3 install package
    // py -m pip install package
    // pip install -r requirements.txt
    // uv pip install package
    // poetry run pip install package
    // pipx run pip install package
    // Any other tool that might wrap pip install
    return /(?:^|\s)(?:\S+\s+)*(?:pip\d*)\s+(install|uninstall)\b/.test(command);
}
