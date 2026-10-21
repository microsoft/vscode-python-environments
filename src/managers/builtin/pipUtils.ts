import * as tomljs from '@iarna/toml';
import { valid as pep440Valid } from '@renovatebot/pep440';
import * as fse from 'fs-extra';
import * as path from 'path';
import {
    CancellationToken,
    l10n,
    LogOutputChannel,
    ProgressLocation,
    QuickInputButtons,
    QuickPickItem,
    Uri,
} from 'vscode';
import { PackageManagementOptions, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { EXTENSION_ROOT_DIR } from '../../common/constants';
import { PackageManagement, Pickers, VenvManagerStrings } from '../../common/localize';
import { traceInfo, traceWarn } from '../../common/logging';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';
import { showErrorMessage, showQuickPickWithButtons, showTextDocument, withProgress } from '../../common/window.apis';
import { findFiles } from '../../common/workspace.apis';
import { throwIfCancelled } from '../../internal/pythonToolSupport';
import { selectFromCommonPackagesToInstall, selectFromInstallableToInstall } from '../common/pickers';
import { normalizePackageName } from '../common/packageUtils';
import { Installable } from '../common/types';
import { mergePackages } from '../common/utils';
import { createPipOrUvCommand } from './commands/factory';
import { PipListCommand, UvListCommand } from './commands/index';

export interface PyprojectToml {
    project?: unknown;
    'build-system'?: unknown;
}

function isTomlTable(value: unknown): value is tomljs.JsonMap {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidPep508Name(value: string): boolean {
    return /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9])$/.test(value);
}

/**
 * Validates the pyproject fields consumed when installing project dependencies.
 * Unknown fields are intentionally ignored so this remains a focused preflight,
 * not a complete pyproject.toml standards validator.
 */
export function validatePyprojectToml(toml: PyprojectToml): string | undefined {
    const buildSystemValue = toml['build-system'];
    if (buildSystemValue !== undefined) {
        if (!isTomlTable(buildSystemValue)) {
            return l10n.t('The [build-system] section must be a table in pyproject.toml.');
        }
        if (buildSystemValue.requires === undefined) {
            return l10n.t('Missing required field "requires" in [build-system] section of pyproject.toml.');
        }
        if (!isStringArray(buildSystemValue.requires)) {
            return l10n.t(
                'The "requires" field in [build-system] must be an array of strings in pyproject.toml.',
            );
        }
    }

    const projectValue = toml.project;
    if (projectValue === undefined) {
        return undefined;
    }
    if (!isTomlTable(projectValue)) {
        return l10n.t('The [project] section must be a table in pyproject.toml.');
    }

    const name = projectValue.name;
    if (name === undefined || name === '') {
        return l10n.t('Missing required field "name" in [project] section of pyproject.toml.');
    }
    if (typeof name !== 'string') {
        return l10n.t('The "name" field in [project] must be a string in pyproject.toml.');
    }

    // PEP 508 names must start and end with a letter or digit and may contain -_., in between.
    if (!isValidPep508Name(name)) {
        return l10n.t('Invalid package name "{0}" in pyproject.toml.', name);
    }

    const version = projectValue.version;
    if (version !== undefined) {
        if (typeof version !== 'string') {
            return l10n.t('The "version" field in [project] must be a string in pyproject.toml.');
        }
        if (version.length === 0) {
            return l10n.t('Version cannot be empty in pyproject.toml.');
        }
        if (!pep440Valid(version)) {
            return l10n.t('Invalid version "{0}" in pyproject.toml.', version);
        }
    }

    const dependencies = projectValue.dependencies;
    if (dependencies !== undefined && !isStringArray(dependencies)) {
        return l10n.t('The "dependencies" field in [project] must be an array of strings in pyproject.toml.');
    }

    const optionalDependencies = projectValue['optional-dependencies'];
    if (optionalDependencies !== undefined) {
        if (!isTomlTable(optionalDependencies)) {
            return l10n.t(
                'The "optional-dependencies" field in [project] must be a table of arrays of strings in pyproject.toml.',
            );
        }
        for (const [group, groupDependencies] of Object.entries(optionalDependencies)) {
            if (!isValidPep508Name(group)) {
                return l10n.t('Invalid optional dependency group name "{0}" in pyproject.toml.', group);
            }
            if (!isStringArray(groupDependencies)) {
                return l10n.t(
                    'Dependency group "{0}" in [project.optional-dependencies] must be an array of strings in pyproject.toml.',
                    group,
                );
            }
        }
    }

    return undefined;
}

interface TomlParseSuccess {
    toml: tomljs.JsonMap;
}

interface TomlParseFailure {
    error: string;
}

type TomlParseResult = TomlParseSuccess | TomlParseFailure;

function conciseError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(/\r?\n/, 1)[0].trim() || l10n.t('Unknown error');
}

async function tomlParse(fsPath: string): Promise<TomlParseResult> {
    try {
        const content = await fse.readFile(fsPath, 'utf-8');
        return { toml: tomljs.parse(content) };
    } catch (error) {
        traceWarn(`Failed to read or parse pyproject.toml at ${fsPath}:`, error);
        return {
            error: l10n.t('Could not read or parse pyproject.toml: {0}', conciseError(error)),
        };
    }
}

function isPipInstallableToml(toml: tomljs.JsonMap): boolean {
    return toml['build-system'] !== undefined && toml.project !== undefined;
}

function isPotentiallyInstallableToml(toml: tomljs.JsonMap): boolean {
    if (isPipInstallableToml(toml)) {
        return true;
    }
    const project = isTomlTable(toml.project) ? toml.project : undefined;
    return project?.['optional-dependencies'] !== undefined;
}

function isTomlRelevantToPreferredRoot(tomlUri: Uri, preferredRoot: Uri | undefined): boolean {
    if (!preferredRoot) {
        return true;
    }
    const tomlDirectory = path.dirname(tomlUri.fsPath);
    return (
        isSameOrParentPath(preferredRoot.fsPath, tomlDirectory) ||
        isSameOrParentPath(tomlDirectory, preferredRoot.fsPath)
    );
}

/**
 * Extracts the declared package name from a parsed `pyproject.toml` (the
 * `[project].name` field, PEP 621). Returns `undefined` when the file does not
 * declare a name.
 */
function getTomlProjectName(toml: tomljs.JsonMap): string | undefined {
    const project = isTomlTable(toml.project) ? toml.project : undefined;
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

    const project = isTomlTable(toml.project) ? toml.project : undefined;
    const optionalDependencies = project?.['optional-dependencies'];
    if (isTomlTable(optionalDependencies)) {
        for (const key of Object.keys(optionalDependencies)) {
            extras.push({
                name: key,
                displayName: key,
                group: 'TOML',
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
    if (installable.length === 0 && common.length === 0 && installableResult.validationErrors.length === 0) {
        return undefined;
    }

    const items: QuickPickItem[] = [];
    if (installable.length > 0 || installableResult.validationErrors.length > 0) {
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
                const selectedInstallables =
                    installable.length > 0
                        ? await selectFromInstallableToInstall(installable, undefined, { showBackButton })
                        : { install: [], uninstall: [] };
                if (!selectedInstallables) {
                    return undefined;
                }

                const shouldProceed = await shouldProceedAfterPyprojectValidation(
                    installableResult.validationErrors,
                    {
                        allPyprojectTomlsSelected: installable.length === 0,
                        selectedPyprojectTomls: selectedInstallables.selectedUris,
                    },
                );
                if (!shouldProceed) {
                    return undefined;
                }

                return { install: selectedInstallables.install, uninstall: selectedInstallables.uninstall };
            } else if (selected.label === PackageManagement.searchCommonPackages) {
                return await selectFromCommonPackagesToInstall(common, installed, undefined, { showBackButton });
            } else if (selected.label === PackageManagement.skipPackageInstallation) {
                traceInfo('Package Installer: user selected skip package installation');
                return { install: [], uninstall: [] } satisfies PipPackages;
            } else {
                return undefined;
            }
        } catch (ex) {
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
     * Validation errors from pyproject.toml files that could provide project dependencies.
     */
    validationErrors: ValidationError[];
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
    token?: CancellationToken;
    runHeadless?: boolean;
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
            try {
                const listCmd: PipListCommand | UvListCommand = await createPipOrUvCommand(
                    { pythonExecutable, log },
                    environment.environmentPath.fsPath,
                    PipListCommand,
                    UvListCommand,
                );
                const data = await withProgress({ location: ProgressLocation.Notification }, () => listCmd.execute());
                installed = data.map((pkg) => pkg.name);
            } catch (error) {
                log?.error('Error listing installed packages', error);
                installed = [];
            }
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
        return { installables: [], validationErrors: [] };
    }
    const exclude = '**/{.venv*,.git,.nox,.tox,.conda,site-packages,__pypackages__}/**';
    const installable: Installable[] = [];
    const validationErrors: ValidationError[] = [];

    const search = async (token?: CancellationToken) => {
        throwIfCancelled(options?.token);
        const results: Uri[] = (
            await Promise.all([
                findFiles('**/*requirements*.txt', exclude, undefined, token),
                findFiles('*requirements*.txt', exclude, undefined, token),
                findFiles('**/requirements/*.txt', exclude, undefined, token),
                findFiles('**/pyproject.toml', exclude, undefined, token),
            ])
        ).flat();

        const uniqueResults = Array.from(new Map(results.map((uri) => [uri.fsPath, uri])).values());
        const fsPaths = projects.map((project) => project.uri.fsPath);
        const depthFromProject = (uri: Uri): number => {
            const projectRoot = api.getPythonProject(uri)?.uri.fsPath;
            if (!projectRoot) {
                return Number.MAX_SAFE_INTEGER;
            }
            const relative = path.relative(projectRoot, uri.fsPath);
            if (!relative) {
                return 0;
            }
            return relative.split(path.sep).filter((segment) => segment.length > 0).length;
        };
        const filtered = uniqueResults
            .filter((uri) => {
                if (
                    options?.runHeadless &&
                    options.preferredRoot &&
                    !isSameOrParentPath(options.preferredRoot.fsPath, uri.fsPath)
                ) {
                    return false;
                }
                const projectRoot = api.getPythonProject(uri)?.uri.fsPath;
                return projectRoot && fsPaths.includes(projectRoot);
            })
            .sort((a, b) => {
                const depthA = depthFromProject(a);
                const depthB = depthFromProject(b);
                if (depthA !== depthB) {
                    return depthA - depthB;
                }
                const pathA = normalizePath(a.fsPath);
                const pathB = normalizePath(b.fsPath);
                return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
            });

        const parsedTomls = new Map<string, TomlParseResult>();
        await Promise.all(
            filtered.map(async (uri) => {
                if (uri.fsPath.endsWith('.toml')) {
                    parsedTomls.set(uri.fsPath, await tomlParse(uri.fsPath));
                }
            }),
        );

        const tomlValidationErrors = new Map<string, string>();
        for (const uri of filtered) {
            const parsed = parsedTomls.get(uri.fsPath);
            if (!parsed || 'error' in parsed) {
                continue;
            }
            const error = validatePyprojectToml(parsed.toml);
            if (
                error &&
                (getTomlInstallable(parsed.toml, uri).length > 0 || isPotentiallyInstallableToml(parsed.toml))
            ) {
                tomlValidationErrors.set(uri.fsPath, error);
            }
        }

        const shouldSkipDisjointToml = (uri: Uri): boolean =>
            !!options?.deduplicateProjectPackages &&
            !isTomlRelevantToPreferredRoot(uri, options.preferredRoot);

        const selectedTomls = new Map<string, Uri>();
        const ambiguousProjectNames = new Set<string>();
        if (options?.deduplicateProjectPackages) {
            const tomlsByProjectName = new Map<string, Uri[]>();
            for (const uri of filtered) {
                if (!uri.fsPath.endsWith('.toml')) {
                    continue;
                }
                const parsed = parsedTomls.get(uri.fsPath);
                if (!parsed || 'error' in parsed || shouldSkipDisjointToml(uri)) {
                    continue;
                }
                const projectName = getTomlProjectName(parsed.toml);
                if (!projectName || getTomlInstallable(parsed.toml, uri).length === 0) {
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
                          .sort((a, b) => path.dirname(b.fsPath).length - path.dirname(a.fsPath).length)
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
                const parsed = parsedTomls.get(uri.fsPath);
                if (!parsed) {
                    continue;
                }
                if ('error' in parsed) {
                    if (isTomlRelevantToPreferredRoot(uri, options?.preferredRoot)) {
                        validationErrors.push({ message: parsed.error, fileUri: uri });
                    } else {
                        traceInfo(
                            `Ignoring invalid pyproject.toml outside the environment creation root: ${uri.fsPath}`,
                        );
                    }
                    continue;
                }

                const validationError = tomlValidationErrors.get(uri.fsPath);
                if (shouldSkipDisjointToml(uri)) {
                    traceInfo(`Skipping pyproject.toml outside the environment creation root: ${uri.fsPath}`);
                    continue;
                }

                const toml = parsed.toml;
                const tomlInstallables = getTomlInstallable(toml, uri);
                const projectName = getTomlProjectName(toml);
                if (options?.deduplicateProjectPackages && projectName) {
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

                if (validationError) {
                    validationErrors.push({ message: validationError, fileUri: uri });
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
        throwIfCancelled(options?.token);
    };

    if (options?.runHeadless) {
        await search(options.token);
    } else {
        await withProgress(
            { location: ProgressLocation.Notification, title: VenvManagerStrings.searchingDependencies },
            (_progress, token) => search(token),
        );
    }

    return { installables: installable, validationErrors };
}

export interface PyprojectValidationSelectionOptions {
    /** Treat every relevant pyproject.toml as selected, as Quick Create does. */
    allPyprojectTomlsSelected?: boolean;
    /** Exact dependency files selected in the configurable package picker. */
    selectedPyprojectTomls?: readonly Uri[];
}

function validationMatchesSelectedToml(
    validationError: ValidationError,
    selectedPyprojectTomls: readonly Uri[] | undefined,
): boolean {
    const validationPath = normalizePath(path.resolve(validationError.fileUri.fsPath));
    return (selectedPyprojectTomls ?? []).some(
        (uri) => normalizePath(path.resolve(uri.fsPath)) === validationPath,
    );
}

/**
 * Prompts before continuing with a selected pyproject.toml that failed parsing or validation.
 * Returns false for Open, Cancel, or dismissal so callers can stop before creating an environment.
 */
export async function shouldProceedAfterPyprojectValidation(
    validationErrors: readonly ValidationError[],
    options?: PyprojectValidationSelectionOptions,
): Promise<boolean> {
    const validationError = options?.allPyprojectTomlsSelected
        ? validationErrors[0]
        : validationErrors.find((error) =>
              validationMatchesSelectedToml(error, options?.selectedPyprojectTomls),
          );
    if (!validationError) {
        return true;
    }

    const openButton = { title: Pickers.pyProject.openFile };
    const continueButton = { title: Pickers.pyProject.continueAnyway };
    const cancelButton = { title: Pickers.pyProject.cancel, isCloseAffordance: true };
    const selection = await showErrorMessage(
        validationError.message + Pickers.pyProject.validationErrorAction,
        openButton,
        continueButton,
        cancelButton,
    );

    if (selection === continueButton) {
        return true;
    }
    if (selection === openButton) {
        await showTextDocument(validationError.fileUri);
    }
    return false;
}
