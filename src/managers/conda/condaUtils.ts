import * as ch from 'child_process';
import {
    EnvironmentManager,
    Package,
    PackageManagementOptions,
    PackageManager,
    PythonCommandRunConfiguration,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
    PythonProject,
} from '../../api';
import * as path from 'path';
import * as os from 'os';
import * as fse from 'fs-extra';
import {
    CancellationError,
    CancellationToken,
    l10n,
    LogOutputChannel,
    ProgressLocation,
    QuickInputButtons,
    QuickPickItem,
    Uri,
} from 'vscode';
import { ENVS_EXTENSION_ID, EXTENSION_ROOT_DIR } from '../../common/constants';
import { createDeferred } from '../../common/utils/deferred';
import {
    isNativeEnvInfo,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../common/nativePythonFinder';
import { getConfiguration } from '../../common/workspace.apis';
import { getGlobalPersistentState, getWorkspacePersistentState } from '../../common/persistentState';
import which from 'which';
import { shortVersion, sortEnvironments } from '../common/utils';
import { pickProject } from '../../common/pickers/projects';
import { CondaStrings, PackageManagement, Pickers } from '../../common/localize';
import { showErrorMessage } from '../../common/errors/utils';
import { showInputBox, showQuickPick, showQuickPickWithButtons, withProgress } from '../../common/window.apis';
import { selectFromCommonPackagesToInstall } from '../common/pickers';
import { quoteArgs } from '../../features/execution/execUtils';
import { traceInfo } from '../../common/logging';
import { untildify } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';

export const CONDA_PATH_KEY = `${ENVS_EXTENSION_ID}:conda:CONDA_PATH`;
export const CONDA_PREFIXES_KEY = `${ENVS_EXTENSION_ID}:conda:CONDA_PREFIXES`;
export const CONDA_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:conda:WORKSPACE_SELECTED`;
export const CONDA_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:conda:GLOBAL_SELECTED`;

export async function clearCondaCache(): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.clear([CONDA_PATH_KEY, CONDA_WORKSPACE_KEY, CONDA_GLOBAL_KEY]);
    const global = await getGlobalPersistentState();
    await global.clear([CONDA_PREFIXES_KEY]);
}

let condaPath: string | undefined;
async function setConda(conda: string): Promise<void> {
    condaPath = conda;
    const state = await getWorkspacePersistentState();
    await state.set(CONDA_PATH_KEY, conda);
}

export function getCondaPathSetting(): string | undefined {
    const config = getConfiguration('python');
    const value = config.get<string>('condaPath');
    return value && typeof value === 'string' ? untildify(value) : value;
}

export async function getCondaForWorkspace(fsPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } | undefined = await state.get(CONDA_WORKSPACE_KEY);
    if (data) {
        try {
            return data[fsPath];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function setCondaForWorkspace(fsPath: string, condaEnvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(CONDA_WORKSPACE_KEY)) ?? {};
    if (condaEnvPath) {
        data[fsPath] = condaEnvPath;
    } else {
        delete data[fsPath];
    }
    await state.set(CONDA_WORKSPACE_KEY, data);
}

export async function setCondaForWorkspaces(fsPath: string[], condaEnvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(CONDA_WORKSPACE_KEY)) ?? {};
    fsPath.forEach((s) => {
        if (condaEnvPath) {
            data[s] = condaEnvPath;
        } else {
            delete data[s];
        }
    });
    await state.set(CONDA_WORKSPACE_KEY, data);
}

export async function getCondaForGlobal(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return await state.get(CONDA_GLOBAL_KEY);
}

export async function setCondaForGlobal(condaEnvPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(CONDA_GLOBAL_KEY, condaEnvPath);
}

async function findConda(): Promise<readonly string[] | undefined> {
    try {
        return await which('conda', { all: true });
    } catch {
        return undefined;
    }
}

export async function getConda(native?: NativePythonFinder): Promise<string> {
    const conda = getCondaPathSetting();
    if (conda) {
        traceInfo(`Using conda from settings: ${conda}`);
        return conda;
    }

    if (condaPath) {
        traceInfo(`Using conda from cache: ${condaPath}`);
        return untildify(condaPath);
    }

    const state = await getWorkspacePersistentState();
    condaPath = await state.get<string>(CONDA_PATH_KEY);
    if (condaPath) {
        traceInfo(`Using conda from persistent state: ${condaPath}`);
        return untildify(condaPath);
    }

    const paths = await findConda();
    if (paths && paths.length > 0) {
        condaPath = paths[0];
        traceInfo(`Using conda from PATH: ${condaPath}`);
        await state.set(CONDA_PATH_KEY, condaPath);
        return condaPath;
    }

    if (native) {
        const data = await native.refresh(false);
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'conda');
        if (managers.length > 0) {
            condaPath = managers[0].executable;
            traceInfo(`Using conda from native finder: ${condaPath}`);
            await state.set(CONDA_PATH_KEY, condaPath);
            return condaPath;
        }
    }

    throw new Error('Conda not found');
}

async function runConda(args: string[], token?: CancellationToken): Promise<string> {
    const conda = await getConda();

    const deferred = createDeferred<string>();
    args = quoteArgs(args);
    const proc = ch.spawn(conda, args, { shell: true });

    token?.onCancellationRequested(() => {
        proc.kill();
        deferred.reject(new CancellationError());
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => {
        stdout += data.toString('utf-8');
    });
    proc.stderr?.on('data', (data) => {
        stderr += data.toString('utf-8');
    });
    proc.on('close', () => {
        deferred.resolve(stdout);
    });
    proc.on('exit', (code) => {
        if (code !== 0) {
            deferred.reject(new Error(`Failed to run "conda ${args.join(' ')}":\n ${stderr}`));
        }
    });

    return deferred.promise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCondaInfo(): Promise<any> {
    const raw = await runConda(['info', '--envs', '--json']);
    return JSON.parse(raw);
}

let prefixes: string[] | undefined;
async function getPrefixes(): Promise<string[]> {
    if (prefixes) {
        return prefixes;
    }

    const state = await getGlobalPersistentState();
    prefixes = await state.get<string[]>(CONDA_PREFIXES_KEY);
    if (prefixes) {
        return prefixes;
    }

    const data = await getCondaInfo();
    prefixes = data['envs_dirs'] as string[];
    await state.set(CONDA_PREFIXES_KEY, prefixes);
    return prefixes;
}

export async function getDefaultCondaPrefix(): Promise<string> {
    const prefixes = await getPrefixes();
    return prefixes.length > 0 ? prefixes[0] : path.join(os.homedir(), '.conda', 'envs');
}

async function getVersion(root: string): Promise<string> {
    const files = await fse.readdir(path.join(root, 'conda-meta'));
    for (let file of files) {
        if (file.startsWith('python-3') && file.endsWith('.json')) {
            const content = fse.readJsonSync(path.join(root, 'conda-meta', file));
            return content['version'] as string;
        }
    }

    throw new Error('Python version not found');
}

function isPrefixOf(roots: string[], e: string): boolean {
    const t = path.normalize(e);
    for (let r of roots.map((r) => path.normalize(r))) {
        if (t.startsWith(r)) {
            return true;
        }
    }
    return false;
}

function pathForGitBash(binPath: string): string {
    return isWindows() ? binPath.replace(/\\/g, '/') : binPath;
}

function getNamedCondaPythonInfo(
    name: string,
    prefix: string,
    executable: string,
    version: string,
    conda: string,
): PythonEnvironmentInfo {
    const sv = shortVersion(version);
    const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    shellActivation.set('gitbash', [{ executable: pathForGitBash(conda), args: ['activate', name] }]);
    shellDeactivation.set('gitbash', [{ executable: pathForGitBash(conda), args: ['deactivate'] }]);

    return {
        name: name,
        environmentPath: Uri.file(prefix),
        displayName: `${name} (${sv})`,
        shortDisplayName: `${name}:${sv}`,
        displayPath: prefix,
        description: undefined,
        tooltip: prefix,
        version: version,
        sysPrefix: prefix,
        execInfo: {
            run: { executable: path.join(executable) },
            activatedRun: {
                executable: conda,
                args: ['run', '--live-stream', '--name', name, 'python'],
            },
            activation: [{ executable: conda, args: ['activate', name] }],
            deactivation: [{ executable: conda, args: ['deactivate'] }],
            shellActivation,
            shellDeactivation,
        },
        group: name !== 'base' ? 'Named' : undefined,
    };
}

function getPrefixesCondaPythonInfo(
    prefix: string,
    executable: string,
    version: string,
    conda: string,
): PythonEnvironmentInfo {
    const sv = shortVersion(version);
    const shellActivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    const shellDeactivation: Map<string, PythonCommandRunConfiguration[]> = new Map();
    shellActivation.set('gitbash', [{ executable: pathForGitBash(conda), args: ['activate', prefix] }]);
    shellDeactivation.set('gitbash', [{ executable: pathForGitBash(conda), args: ['deactivate'] }]);

    const basename = path.basename(prefix);
    return {
        name: basename,
        environmentPath: Uri.file(prefix),
        displayName: `${basename} (${sv})`,
        shortDisplayName: `${basename}:${sv}`,
        displayPath: prefix,
        description: undefined,
        tooltip: prefix,
        version: version,
        sysPrefix: prefix,
        execInfo: {
            run: { executable: path.join(executable) },
            activatedRun: {
                executable: conda,
                args: ['run', '--live-stream', '--prefix', prefix, 'python'],
            },
            activation: [{ executable: conda, args: ['activate', prefix] }],
            deactivation: [{ executable: conda, args: ['deactivate'] }],
            shellActivation,
            shellDeactivation,
        },
        group: 'Prefix',
    };
}

function nativeToPythonEnv(
    e: NativeEnvInfo,
    api: PythonEnvironmentApi,
    manager: EnvironmentManager,
    log: LogOutputChannel,
    conda: string,
    condaPrefixes: string[],
): PythonEnvironment | undefined {
    if (!(e.prefix && e.executable && e.version)) {
        log.warn(`Invalid conda environment: ${JSON.stringify(e)}`);
        return;
    }

    if (e.name === 'base') {
        const environment = api.createPythonEnvironmentItem(
            getNamedCondaPythonInfo('base', e.prefix, e.executable, e.version, conda),
            manager,
        );
        log.info(`Found base environment: ${e.prefix}`);
        return environment;
    } else if (!isPrefixOf(condaPrefixes, e.prefix)) {
        const environment = api.createPythonEnvironmentItem(
            getPrefixesCondaPythonInfo(e.prefix, e.executable, e.version, conda),
            manager,
        );
        log.info(`Found prefix environment: ${e.prefix}`);
        return environment;
    } else {
        const basename = path.basename(e.prefix);
        const name = e.name ?? basename;
        const environment = api.createPythonEnvironmentItem(
            getNamedCondaPythonInfo(name, e.prefix, e.executable, e.version, conda),
            manager,
        );
        log.info(`Found named environment: ${e.prefix}`);
        return environment;
    }
}

export async function resolveCondaPath(
    fsPath: string,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
): Promise<PythonEnvironment | undefined> {
    try {
        const e = await nativeFinder.resolve(fsPath);
        if (e.kind !== NativePythonEnvironmentKind.conda) {
            return undefined;
        }
        const conda = await getConda();
        const condaPrefixes = await getPrefixes();
        return nativeToPythonEnv(e, api, manager, log, conda, condaPrefixes);
    } catch {
        return undefined;
    }
}

export async function refreshCondaEnvs(
    hardRefresh: boolean,
    nativeFinder: NativePythonFinder,
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
): Promise<PythonEnvironment[]> {
    log.info('Refreshing conda environments');
    const data = await nativeFinder.refresh(hardRefresh);

    let conda: string | undefined = undefined;
    try {
        conda = await getConda();
    } catch {
        conda = undefined;
    }
    if (conda === undefined) {
        const managers = data
            .filter((e) => !isNativeEnvInfo(e))
            .map((e) => e as NativeEnvManagerInfo)
            .filter((e) => e.tool.toLowerCase() === 'conda');
        conda = managers[0].executable;
        await setConda(conda);
    }

    const condaPath = conda;

    if (condaPath) {
        const condaPrefixes = await getPrefixes();
        const envs = data
            .filter((e) => isNativeEnvInfo(e))
            .map((e) => e as NativeEnvInfo)
            .filter((e) => e.kind === NativePythonEnvironmentKind.conda);
        const collection: PythonEnvironment[] = [];

        envs.forEach((e) => {
            const environment = nativeToPythonEnv(e, api, manager, log, condaPath, condaPrefixes);
            if (environment) {
                collection.push(environment);
            }
        });

        return sortEnvironments(collection);
    }

    log.error('Conda not found');
    return [];
}

function getName(api: PythonEnvironmentApi, uris?: Uri | Uri[]): string | undefined {
    if (!uris) {
        return undefined;
    }
    if (Array.isArray(uris) && uris.length !== 1) {
        return undefined;
    }
    return api.getPythonProject(Array.isArray(uris) ? uris[0] : uris)?.name;
}

async function getLocation(api: PythonEnvironmentApi, uris: Uri | Uri[]): Promise<string | undefined> {
    if (!uris || (Array.isArray(uris) && (uris.length === 0 || uris.length > 1))) {
        const projects: PythonProject[] = [];
        if (Array.isArray(uris)) {
            for (let uri of uris) {
                const project = api.getPythonProject(uri);
                if (project && !projects.includes(project)) {
                    projects.push(project);
                }
            }
        } else {
            api.getPythonProjects().forEach((p) => projects.push(p));
        }
        const project = await pickProject(projects);
        return project?.uri.fsPath;
    }
    return api.getPythonProject(Array.isArray(uris) ? uris[0] : uris)?.uri.fsPath;
}

export async function createCondaEnvironment(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    uris?: Uri | Uri[],
): Promise<PythonEnvironment | undefined> {
    // step1 ask user for named or prefix environment
    const envType =
        Array.isArray(uris) && uris.length > 1
            ? 'Named'
            : (
                  await showQuickPick(
                      [
                          { label: CondaStrings.condaNamed, description: CondaStrings.condaNamedDescription },
                          { label: CondaStrings.condaPrefix, description: CondaStrings.condaPrefixDescription },
                      ],
                      {
                          placeHolder: CondaStrings.condaSelectEnvType,
                          ignoreFocusOut: true,
                      },
                  )
              )?.label;

    if (envType) {
        return envType === CondaStrings.condaNamed
            ? await createNamedCondaEnvironment(api, log, manager, getName(api, uris ?? []))
            : await createPrefixCondaEnvironment(api, log, manager, await getLocation(api, uris ?? []));
    }
    return undefined;
}

async function createNamedCondaEnvironment(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    name?: string,
): Promise<PythonEnvironment | undefined> {
    name = await showInputBox({
        prompt: CondaStrings.condaNamedInput,
        value: name,
        ignoreFocusOut: true,
    });
    if (!name) {
        return;
    }

    const envName: string = name;

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: l10n.t('Creating conda environment: {0}', envName),
        },
        async () => {
            try {
                const bin = os.platform() === 'win32' ? 'python.exe' : 'python';
                const output = await runConda(['create', '--yes', '--name', envName, 'python']);
                log.info(output);

                const prefixes = await getPrefixes();
                let envPath = '';
                for (let prefix of prefixes) {
                    if (await fse.pathExists(path.join(prefix, envName))) {
                        envPath = path.join(prefix, envName);
                        break;
                    }
                }
                const version = await getVersion(envPath);

                const environment = api.createPythonEnvironmentItem(
                    getNamedCondaPythonInfo(envName, envPath, path.join(envPath, bin), version, await getConda()),
                    manager,
                );
                return environment;
            } catch (e) {
                log.error('Failed to create conda environment', e);
                setImmediate(async () => {
                    await showErrorMessage(CondaStrings.condaCreateFailed, log);
                });
            }
        },
    );
}

async function createPrefixCondaEnvironment(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    fsPath?: string,
): Promise<PythonEnvironment | undefined> {
    if (!fsPath) {
        return;
    }

    let name = `./.conda`;
    if (await fse.pathExists(path.join(fsPath, '.conda'))) {
        log.warn(`Environment "${path.join(fsPath, '.conda')}" already exists`);
        const newName = await showInputBox({
            prompt: l10n.t('Environment "{0}" already exists. Enter a different name', name),
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (value === name) {
                    return CondaStrings.condaExists;
                }
                return undefined;
            },
        });
        if (!newName) {
            return;
        }
        name = newName;
    }

    const prefix: string = path.isAbsolute(name) ? name : path.join(fsPath, name);

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: `Creating conda environment: ${name}`,
        },
        async () => {
            try {
                const bin = os.platform() === 'win32' ? 'python.exe' : 'python';
                const output = await runConda(['create', '--yes', '--prefix', prefix, 'python']);
                log.info(output);
                const version = await getVersion(prefix);

                const environment = api.createPythonEnvironmentItem(
                    getPrefixesCondaPythonInfo(prefix, path.join(prefix, bin), version, await getConda()),
                    manager,
                );
                return environment;
            } catch (e) {
                log.error('Failed to create conda environment', e);
                setImmediate(async () => {
                    await showErrorMessage(CondaStrings.condaCreateFailed, log);
                });
            }
        },
    );
}

export async function generateName(fsPath: string): Promise<string | undefined> {
    let attempts = 0;
    while (attempts < 5) {
        const randomStr = Math.random().toString(36).substring(2);
        const name = `env_${randomStr}`;
        const prefix = path.join(fsPath, name);
        if (!(await fse.exists(prefix))) {
            return name;
        }
    }
    return undefined;
}

export async function quickCreateConda(
    api: PythonEnvironmentApi,
    log: LogOutputChannel,
    manager: EnvironmentManager,
    fsPath: string,
    name: string,
    additionalPackages?: string[],
): Promise<PythonEnvironment | undefined> {
    const prefix = path.join(fsPath, name);

    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: `Creating conda environment: ${name}`,
        },
        async () => {
            try {
                const bin = os.platform() === 'win32' ? 'python.exe' : 'python';
                log.info(await runConda(['create', '--yes', '--prefix', prefix, 'python']));
                if (additionalPackages && additionalPackages.length > 0) {
                    log.info(await runConda(['install', '--yes', '--prefix', prefix, ...additionalPackages]));
                }
                const version = await getVersion(prefix);

                const environment = api.createPythonEnvironmentItem(
                    {
                        name: path.basename(prefix),
                        environmentPath: Uri.file(prefix),
                        displayName: `${version} (${name})`,
                        displayPath: prefix,
                        description: prefix,
                        version,
                        execInfo: {
                            run: { executable: path.join(prefix, bin) },
                            activatedRun: {
                                executable: 'conda',
                                args: ['run', '--live-stream', '-p', prefix, 'python'],
                            },
                            activation: [{ executable: 'conda', args: ['activate', prefix] }],
                            deactivation: [{ executable: 'conda', args: ['deactivate'] }],
                        },
                        sysPrefix: prefix,
                        group: 'Prefix',
                    },
                    manager,
                );
                return environment;
            } catch (e) {
                log.error('Failed to create conda environment', e);
                setImmediate(async () => {
                    await showErrorMessage(CondaStrings.condaCreateFailed, log);
                });
            }
        },
    );
}

export async function deleteCondaEnvironment(environment: PythonEnvironment, log: LogOutputChannel): Promise<boolean> {
    let args = ['env', 'remove', '--yes', '--prefix', environment.environmentPath.fsPath];
    return await withProgress(
        {
            location: ProgressLocation.Notification,
            title: l10n.t('Deleting conda environment: {0}', environment.environmentPath.fsPath),
        },
        async () => {
            try {
                await runConda(args);
            } catch (e) {
                log.error(`Failed to delete conda environment: ${e}`);
                setImmediate(async () => {
                    await showErrorMessage(CondaStrings.condaRemoveFailed, log);
                });
                return false;
            }
            return true;
        },
    );
}

export async function refreshPackages(
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    manager: PackageManager,
): Promise<Package[]> {
    let args = ['list', '-p', environment.environmentPath.fsPath];
    const data = await runConda(args);
    const content = data.split(/\r?\n/).filter((l) => !l.startsWith('#'));
    const packages: Package[] = [];
    content.forEach((l) => {
        const parts = l.split(' ').filter((p) => p.length > 0);
        if (parts.length === 3) {
            const pkg = api.createPackageItem(
                {
                    name: parts[0],
                    displayName: parts[0],
                    version: parts[1],
                    description: parts[1],
                },
                environment,
                manager,
            );
            packages.push(pkg);
        }
    });
    return packages;
}

export async function managePackages(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
    api: PythonEnvironmentApi,
    manager: PackageManager,
    token: CancellationToken,
): Promise<Package[]> {
    if (options.uninstall && options.uninstall.length > 0) {
        await runConda(
            ['remove', '--prefix', environment.environmentPath.fsPath, '--yes', ...options.uninstall],
            token,
        );
    }
    if (options.install && options.install.length > 0) {
        const args = ['install', '--prefix', environment.environmentPath.fsPath, '--yes'];
        if (options.upgrade) {
            args.push('--update-all');
        }
        args.push(...options.install);
        await runConda(args, token);
    }
    return refreshPackages(environment, api, manager);
}

async function getCommonPackages(): Promise<Installable[]> {
    try {
        const pipData = path.join(EXTENSION_ROOT_DIR, 'files', 'conda_packages.json');
        const data = await fse.readFile(pipData, { encoding: 'utf-8' });
        const packages = JSON.parse(data) as { name: string; description: string; uri: string }[];

        return packages.map((p) => {
            return {
                name: p.name,
                displayName: p.name,
                uri: Uri.parse(p.uri),
                description: p.description,
            };
        });
    } catch {
        return [];
    }
}

interface CondaPackagesResult {
    install: string[];
    uninstall: string[];
}

async function selectCommonPackagesOrSkip(
    common: Installable[],
    installed: string[],
    showSkipOption: boolean,
): Promise<CondaPackagesResult | undefined> {
    if (common.length === 0) {
        return undefined;
    }

    const items: QuickPickItem[] = [];
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
            if (selected.label === PackageManagement.searchCommonPackages) {
                return await selectFromCommonPackagesToInstall(common, installed, undefined, { showBackButton });
            } else {
                traceInfo('Package Installer: user selected skip package installation');
                return undefined;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (ex: any) {
            if (ex === QuickInputButtons.Back) {
                return selectCommonPackagesOrSkip(common, installed, showSkipOption);
            }
        }
    }
    return undefined;
}

export async function getCommonCondaPackagesToInstall(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
    api: PythonEnvironmentApi,
): Promise<CondaPackagesResult | undefined> {
    const common = await getCommonPackages();
    const installed = (await api.getPackages(environment))?.map((p) => p.name);
    const selected = await selectCommonPackagesOrSkip(common, installed ?? [], !!options.showSkipOption);
    return selected;
}
