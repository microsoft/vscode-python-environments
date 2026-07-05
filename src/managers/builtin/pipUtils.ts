import * as tomljs from '@iarna/toml';
import { valid as pep440Valid } from '@renovatebot/pep440';
import * as fse from 'fs-extra';
import * as path from 'path';
import { l10n, LogOutputChannel, ProgressLocation, QuickInputButtons, QuickPickItem, Uri, window } from 'vscode';
import { PackageManagementOptions, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { EXTENSION_ROOT_DIR } from '../../common/constants';
import { PackageManagement, Pickers, VenvManagerStrings } from '../../common/localize';
import { traceInfo } from '../../common/logging';
import { normalizePath } from '../../common/utils/pathUtils';
import { showQuickPickWithButtons, withProgress } from '../../common/window.apis';
import { findFiles } from '../../common/workspace.apis';
import { selectFromCommonPackagesToInstall, selectFromInstallableToInstall } from '../common/pickers';
import { Installable } from '../common/types';
import { mergePackages } from '../common/utils';
import { normalizePackageName } from './utils';
import { PipListCommand, UvListCommand } from './commands/index';
import { shouldUseUv } from './helpers';

export interface PyprojectToml {
    project?: {
        name?: string;
        version?: string;
    };
    'build-system'?: {
        requires?: unknown;
    };
}

export function validatePyprojectToml(toml: PyprojectToml): string | undefined {
    // 1. Validate required "requires" field in [build-system] section (PEP 518)
    const buildSystem = toml['build-system'];
    if (buildSystem && !buildSystem.requires) {
        // See PEP 518: https://peps.python.org/pep-0518/
        return l10n.t('Missing required field "requires" in [build-system] section of pyproject.toml.');
    }

    const project = toml.project;
    if (!project) {
        return undefined;
    }

    const name = project.name;
    // 2. Validate required "name" field in [project] section (PEP 621)
    // See PEP 621: https://peps.python.org/pep-0621/
    if (!name) {
        return l10n.t('Missing required field "name" in [project] section of pyproject.toml.');
    }

    // 3. Validate package name (PEP 508)
    // PEP 508 regex: must start and end with a letter or digit, can contain -_., and alphanumeric characters. No spaces allowed.
    // See https://peps.python.org/pep-0508/
    const nameRegex = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9])$/;
    if (!nameRegex.test(name)) {
        return l10n.t('Invalid package name "{0}" in pyproject.toml.', name);
    }

    // 4. Validate version format (PEP 440)
    const version = project.version;
    if (version !== undefined) {
        if (version.length === 0) {
            return l10n.t('Version cannot be empty in pyproject.toml.');
        }
        if (!pep440Valid(version)) {
            return l10n.t('Invalid version "{0}" in pyproject.toml.', version);
        }
    }

    return undefined;
}

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

/**
 * Extracts the declared package name from a parsed `pyproject.toml` (the
 * `[project].name` field, PEP 621). Returns `undefined` when the file does not
 * declare a name.
 */
function getTomlProjectName(toml: tomljs.JsonMap): string | undefined {
    const project = toml.project as tomljs.JsonMap | undefined;
    const name = project?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function getTomlInstallable(toml: tomljs.JsonMap, tomlPath: Uri): Installable[] {
    const extras: Installable[] = [];
    const projectDir = path.dirname(tomlPath.fsPath);

    if (isPipInstallableToml(toml)) {
        const name = path.basename(tomlPath.fsPath);
        extras.push({
            name,
            displayName: name,
            description: VenvManagerStrings.installEditable,
            group: 'TOML',
            args: ['-e', projectDir],
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
                // Use a single -e argument with the extras specified as part of the path
                args: ['-e', `${projectDir}[${key}]`],
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
    installableResult: ProjectInstallableResult,
    common: Installable[],
    showSkipOption: boolean,
    installed: string[],
): Promise<PipPackages | undefined> {
    const installable = installableResult.installables;
    if (installable.length === 0 && common.length === 0) {
        return undefined;
    }

    const items: QuickPickItem[] = [];
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

    let showBackButton = true;
    let selected: QuickPickItem[] | QuickPickItem | undefined = undefined;
    if (items.length === 1) {
        selected = items[0];
        showBackButton = false;
    } else {
        selected = await showQuickPickWithButtons(items, {
            placeHolder: Pickers.Packages.selectOption,
            ignoreFocusOut: true,
            showBackButton: true,
            matchOnDescription: false,
            matchOnDetail: false,
        });
    }

    if (selected && !Array.isArray(selected)) {
        try {
            if (selected.label === PackageManagement.workspaceDependencies) {
                const selectedInstallables = await selectFromInstallableToInstall(installable, undefined, {
                    showBackButton,
                });

                const validationError = installableResult.validationError;
                const shouldProceed = await shouldProceedAfterPyprojectValidation(
                    validationError,
                    selectedInstallables?.install ?? [],
                );
                if (!shouldProceed) {
                    return undefined;
                }

                return selectedInstallables;
            } else if (selected.label === PackageManagement.searchCommonPackages) {
                return await selectFromCommonPackagesToInstall(common, installed, undefined, { showBackButton });
            } else if (selected.label === PackageManagement.skipPackageInstallation) {
                traceInfo('Package Installer: user selected skip package installation');
                return { install: [], uninstall: [] } satisfies PipPackages;
            } else {
                return undefined;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (ex: any) {
            if (ex === QuickInputButtons.Back) {
                return selectWorkspaceOrCommon(installableResult, common, showSkipOption, installed);
            }
        }
    }
    return undefined;
}

export interface PipPackages {
    install: string[];
    uninstall: string[];
}

export interface ProjectInstallableResult {
    /**
     * List of installable packages from pyproject.toml file
     */
    installables: Installable[];

    /**
     * Validation error information if pyproject.toml validation failed
     */
    validationError?: ValidationError;
}

export interface ValidationError {
    /**
     * Human-readable error message describing the validation issue
     */
    message: string;

    /**
     * URI to the pyproject.toml file that has the validation error
     */
    fileUri: Uri;
}

export interface ProjectInstallableOptions {
    /**
     * Prevent automatic installation from passing multiple editable sources for
     * the same Python package to pip.
     */
    deduplicateProjectPackages?: boolean;

    /**
     * Creation root used to prefer the pyproject.toml that owns the environment.
     */
    preferredRoot?: Uri;
}

export async function getWorkspacePackagesToInstall(
    api: PythonEnvironmentApi,
    options: PackageManagementOptions,
    project?: PythonProject[],
    environment?: PythonEnvironment,
    log?: LogOutputChannel,
): Promise<PipPackages | undefined> {
    const installableResult = await getProjectInstallable(api, project);
    let common = await getCommonPackages();
    let installed: string[] | undefined;
    if (environment) {
        const pythonExecutable = environment.execInfo?.run?.executable;
        if (pythonExecutable) {
            const useUv = await shouldUseUv(log, environment.environmentPath.fsPath);
            const ListCmd = useUv ? UvListCommand : PipListCommand;
            const listCmd = new ListCmd({ pythonExecutable, log });
            const data = await listCmd.executeWithProgress<{ name: string }[]>({ showProgress: true });
            installed = data?.map((pkg) => pkg.name);
        }
        common = mergePackages(common, installed ?? []);
    }
    return selectWorkspaceOrCommon(installableResult, common, !!options.showSkipOption, installed ?? []);
}

export async function getProjectInstallable(
    api: PythonEnvironmentApi,
    projects?: PythonProject[],
    options?: ProjectInstallableOptions,
): Promise<ProjectInstallableResult> {
    if (!projects) {
        return { installables: [] };
    }
    const exclude = '**/{.venv*,.git,.nox,.tox,.conda,site-packages,__pypackages__}/**';
    const installable: Installable[] = [];
    let validationError: { message: string; fileUri: Uri } | undefined;

    await withProgress(
        {
            location: ProgressLocation.Notification,
            title: VenvManagerStrings.searchingDependencies,
        },
        async (_progress, token) => {
            const results: Uri[] = (
                await Promise.all([
                    findFiles('**/*requirements*.txt', exclude, undefined, token),
                    findFiles('*requirements*.txt', exclude, undefined, token),
                    findFiles('**/requirements/*.txt', exclude, undefined, token),
                    findFiles('**/pyproject.toml', exclude, undefined, token),
                ])
            ).flat();

            // Deduplicate by fsPath
            const uniqueResults = Array.from(new Map(results.map((uri) => [uri.fsPath, uri])).values());

            const fsPaths = projects.map((p) => p.uri.fsPath);
            // Compute depth relative to the owning project root so ordering reflects
            // "shallower within the project", independent of where the project lives on disk.
            const depthFromProject = (uri: Uri): number => {
                const projectRoot = api.getPythonProject(uri)?.uri.fsPath;
                if (!projectRoot) {
                    return Number.MAX_SAFE_INTEGER;
                }
                const rel = path.relative(projectRoot, uri.fsPath);
                if (!rel) {
                    return 0;
                }
                return rel.split(path.sep).filter((segment) => segment.length > 0).length;
            };
            const filtered = uniqueResults
                .filter((uri) => {
                    const p = api.getPythonProject(uri)?.uri.fsPath;
                    return p && fsPaths.includes(p);
                })
                .sort((a, b) => {
                    // Sort by path depth relative to the project root (shallowest first) so
                    // top-level files like requirements.txt appear before deeply nested ones.
                    const depthA = depthFromProject(a);
                    const depthB = depthFromProject(b);
                    if (depthA !== depthB) {
                        return depthA - depthB;
                    }
                    const pathA = normalizePath(a.fsPath);
                    const pathB = normalizePath(b.fsPath);
                    return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
                });

            // Parse all TOML files first (in parallel), keyed by fsPath, so the
            // subsequent duplicate-detection pass can run sequentially and
            // deterministically over the depth-sorted `filtered` list.
            const parsedTomls = new Map<string, tomljs.JsonMap>();
            await Promise.all(
                filtered.map(async (uri) => {
                    if (uri.fsPath.endsWith('.toml')) {
                        const toml = await tomlParse(uri.fsPath);
                        parsedTomls.set(uri.fsPath, toml);
                    }
                }),
            );

            const selectedTomls = new Map<string, Uri>();
            const ambiguousProjectNames = new Set<string>();
            if (options?.deduplicateProjectPackages) {
                const tomlsByProjectName = new Map<string, Uri[]>();
                for (const uri of filtered) {
                    if (!uri.fsPath.endsWith('.toml')) {
                        continue;
                    }
                    const toml = parsedTomls.get(uri.fsPath) ?? {};
                    const projectName = getTomlProjectName(toml);
                    if (!projectName || getTomlInstallable(toml, uri).length === 0) {
                        continue;
                    }
                    const normalizedName = normalizePackageName(projectName);
                    const candidates = tomlsByProjectName.get(normalizedName) ?? [];
                    candidates.push(uri);
                    tomlsByProjectName.set(normalizedName, candidates);
                }

                tomlsByProjectName.forEach((candidates, projectName) => {
                    if (candidates.length === 1) {
                        selectedTomls.set(projectName, candidates[0]);
                        return;
                    }

                    const preferredRoot = options.preferredRoot?.fsPath;
                    const preferredCandidates = preferredRoot
                        ? candidates
                              .filter((candidate) => {
                                  const projectDir = path.dirname(candidate.fsPath);
                                  const relative = path.relative(projectDir, preferredRoot);
                                  return (
                                      relative === '' ||
                                      (relative !== '..' &&
                                          !relative.startsWith(`..${path.sep}`) &&
                                          !path.isAbsolute(relative))
                                  );
                              })
                              .sort(
                                  (a, b) =>
                                      path.dirname(b.fsPath).length - path.dirname(a.fsPath).length,
                              )
                        : [];

                    if (preferredCandidates.length > 0) {
                        selectedTomls.set(projectName, preferredCandidates[0]);
                    } else {
                        ambiguousProjectNames.add(projectName);
                        traceInfo(
                            `Skipping ambiguous editable installs for package "${projectName}" because no ` +
                                'candidate contains the environment creation root.',
                        );
                    }
                });
            }

            for (const uri of filtered) {
                if (uri.fsPath.endsWith('.toml')) {
                    const toml = parsedTomls.get(uri.fsPath) ?? {};
                    const tomlInstallables = getTomlInstallable(toml, uri);

                    const projectName = getTomlProjectName(toml);
                    if (options?.deduplicateProjectPackages && projectName && tomlInstallables.length > 0) {
                        const normalizedName = normalizePackageName(projectName);
                        const selected = selectedTomls.get(normalizedName);
                        if (ambiguousProjectNames.has(normalizedName)) {
                            continue;
                        }
                        if (selected && selected.fsPath !== uri.fsPath) {
                            traceInfo(
                                `Skipping duplicate project package "${projectName}" from ${uri.fsPath}; it is ` +
                                    `already provided by ${selected.fsPath}.`,
                            );
                            continue;
                        }
                    }

                    // Validate pyproject.toml (report only the first error found).
                    if (!validationError) {
                        const error = validatePyprojectToml(toml);
                        if (error) {
                            validationError = {
                                message: error,
                                fileUri: uri,
                            };
                        }
                    }

                    installable.push(...tomlInstallables);
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
            }
        },
    );

    return {
        installables: installable,
        validationError,
    };
}

export async function shouldProceedAfterPyprojectValidation(
    validationError: ValidationError | undefined,
    install: string[],
): Promise<boolean> {
    // 1. If no validation error or no installables selected, proceed
    if (!validationError || install.length === 0) {
        return true;
    }

    const selectedTomlInstallables = install.some((arg, index, arr) => arg === '-e' && index + 1 < arr.length);
    if (!selectedTomlInstallables) {
        // 2. If no toml installables selected, proceed
        return true;
    }

    // 3. Otherwise, show error message and ask user what to do
    const openButton = { title: Pickers.pyProject.openFile };
    const continueButton = { title: Pickers.pyProject.continueAnyway };
    const cancelButton = { title: Pickers.pyProject.cancel, isCloseAffordance: true };

    const selection = await window.showErrorMessage(
        validationError.message + Pickers.pyProject.validationErrorAction,
        openButton,
        continueButton,
        cancelButton,
    );

    if (selection === continueButton) {
        return true;
    }

    if (selection === openButton) {
        await window.showTextDocument(validationError.fileUri);
    }

    return false;
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
