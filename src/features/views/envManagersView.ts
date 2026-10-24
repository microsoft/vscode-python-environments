import { Disposable, Event, EventEmitter, ProviderResult, TreeDataProvider, TreeItem, TreeView } from 'vscode';
import { DidChangeEnvironmentEventArgs, EnvironmentGroupInfo, PythonEnvironment } from '../../api';
import { VENV_MANAGER_ID } from '../../common/constants';
import { ProjectViews } from '../../common/localize';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { createTreeView } from '../../common/window.apis';
import type {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagers,
    InternalDidChangeEnvironmentsEventArgs,
    InternalDidChangePackagesEventArgs,
} from '../envManagers';
import { ITemporaryStateManager } from './temporaryStateManager';
import {
    EnvInfoTreeItem,
    EnvManagerTreeItem,
    EnvTreeItem,
    EnvTreeItemKind,
    getEnvironmentParentDirName,
    NoPythonEnvTreeItem,
    PackageTreeItem,
    PythonEnvTreeItem,
    PythonGroupEnvTreeItem,
} from './treeViewItems';

const COPIED_STATE = 'copied';
const SELECTED_STATE = 'selected';
const ENV_STATE_KEYS = [COPIED_STATE, SELECTED_STATE];

/**
 * Extracts the base name from a display name by removing version info.
 * @example getBaseName('.venv (3.12)') returns '.venv'
 * @example getBaseName('myenv (3.14.1)') returns 'myenv'
 */
function getBaseName(displayName: string): string {
    return displayName.replace(/\s*\((?:[0-9.]+|no-python)\)\s*$/, '').trim();
}

/**
 * Checks if an environment is a virtual environment (project-scoped venv/poetry/pipenv).
 */
function isVirtualEnv(env: PythonEnvironment): boolean {
    if (
        env.envId.managerId === VENV_MANAGER_ID ||
        env.envId.managerId.includes('venv') ||
        env.envId.managerId.includes('pipenv') ||
        env.envId.managerId.includes('poetry')
    ) {
        return true;
    }

    const envPath = (env.environmentPath.fsPath || '').replace(/\\/g, '/');
    const parts = envPath.split('/').filter((p) => p.length > 0);

    let binIndex = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
        const lower = parts[i].toLowerCase();
        if (lower === 'bin' || lower === 'scripts') {
            binIndex = i;
            break;
        }
    }

    if (binIndex > 0) {
        const folder = parts[binIndex - 1].toLowerCase();
        if (
            folder === '.venv' ||
            folder === 'venv' ||
            folder === 'env' ||
            folder === '.env' ||
            folder === 'virtualenv' ||
            folder.startsWith('.venv') ||
            folder.startsWith('venv-') ||
            folder.includes('virtualenv')
        ) {
            return true;
        }
    }

    if (parts.length > 0) {
        const lastPart = parts[parts.length - 1].toLowerCase();
        if (
            lastPart === '.venv' ||
            lastPart === 'venv' ||
            lastPart === 'env' ||
            lastPart === '.env' ||
            lastPart === 'virtualenv' ||
            lastPart.startsWith('.venv') ||
            lastPart.startsWith('venv-')
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Checks if an environment is a Conda environment without Python.
 */
function isPythonLessEnv(env: PythonEnvironment): boolean {
    if (env.version === 'no-python') {
        return true;
    }
    const nameLower = (env.displayName || env.name || '').toLowerCase();
    if (nameLower.includes('no-python')) {
        return true;
    }
    const exec = (env.execInfo?.run?.executable || '').replace(/\\/g, '/').toLowerCase();
    if (exec.endsWith('/conda') || exec.endsWith('/conda.exe') || exec.endsWith('/conda.bat')) {
        return true;
    }
    return false;
}

/**
 * Computes disambiguation suffixes for environments with similar base names.
 *
 * When multiple environments share the same base name (ignoring version numbers),
 * this function returns a map from environment ID to a distinguishing suffix:
 * - For virtual environments, returns the parent project directory name.
 * - For non-virtual environments (such as global/system interpreters), uses the distinguishing
 *   executable folder, or the executable name when environments share the same directory.
 * - For Python-less Conda environments, uses the environment location/prefix directory.
 * - When candidate suffixes collide across distinct roots (e.g. C:\Python313 vs D:\Python313),
 *   additional ancestor segments are included until suffixes are unique and unambiguous.
 *
 * @param envs List of environments to analyze
 * @returns Map from environment ID to disambiguation suffix
 */
export function computeDisambiguationSuffixes(envs: PythonEnvironment[]): Map<string, string> {
    const suffixes = new Map<string, string>();

    // Group environments by their base name (ignoring version)
    const baseNameToEnvs = new Map<string, PythonEnvironment[]>();
    for (const env of envs) {
        const displayName = env.displayName ?? env.name;
        const baseName = getBaseName(displayName);
        const existing = baseNameToEnvs.get(baseName) ?? [];
        existing.push(env);
        baseNameToEnvs.set(baseName, existing);
    }

    // For base names with multiple environments, compute suffixes
    for (const [, similarEnvs] of baseNameToEnvs) {
        if (similarEnvs.length <= 1) {
            continue;
        }

        // Map non-virtual, non-PythonLess interpreters by directory path to identify same-folder executables
        const dirMap = new Map<string, PythonEnvironment[]>();
        for (const env of similarEnvs) {
            if (!isVirtualEnv(env) && !isPythonLessEnv(env)) {
                const execPath = (env.execInfo?.run?.executable || env.environmentPath.fsPath).replace(/\\/g, '/');
                const parts = execPath.split('/').filter((p) => p.length > 0);
                const dirPath = parts.slice(0, -1).join('/');
                const list = dirMap.get(dirPath) ?? [];
                list.push(env);
                dirMap.set(dirPath, list);
            }
        }

        interface EnvDisambiguationItem {
            env: PythonEnvironment;
            parts: string[];
            isBinDir: boolean;
            depth: number;
            currentSuffix: string;
        }

        const items: EnvDisambiguationItem[] = similarEnvs.map((env) => {
            const isVenv = isVirtualEnv(env);
            const isNoPy = !isVenv && isPythonLessEnv(env);

            if (isVenv) {
                const envPath = (env.environmentPath.fsPath || '').replace(/\\/g, '/');
                const parts = envPath.split('/').filter((p) => p.length > 0);
                let venvIndex = -1;
                for (let i = parts.length - 1; i >= 0; i--) {
                    const part = parts[i].toLowerCase();
                    if (part === 'bin' || part === 'scripts') {
                        venvIndex = i - 1;
                        break;
                    }
                    if (part.startsWith('python')) {
                        continue;
                    }
                    venvIndex = i;
                    break;
                }
                const projectParts = venvIndex > 0 ? parts.slice(0, venvIndex) : parts;
                const finalParts = projectParts.length > 0 ? projectParts : [getEnvironmentParentDirName(env)];
                const initialSuffix = getEnvironmentParentDirName(env);
                return {
                    env,
                    parts: finalParts,
                    isBinDir: false,
                    depth: 1,
                    currentSuffix: initialSuffix,
                };
            }

            if (isNoPy) {
                const envPath = (env.environmentPath.fsPath || env.sysPrefix || '').replace(/\\/g, '/');
                const parts = envPath.split('/').filter((p) => p.length > 0);
                return {
                    env,
                    parts,
                    isBinDir: false,
                    depth: 1,
                    currentSuffix: parts[parts.length - 1] || '',
                };
            }

            const execPath = (env.execInfo?.run?.executable || env.environmentPath.fsPath).replace(/\\/g, '/');
            const parts = execPath.split('/').filter((p) => p.length > 0);
            const execName = parts[parts.length - 1] || '';
            const dirParts = parts.slice(0, -1);
            const dirPath = dirParts.join('/');
            const sameDirEnvs = dirMap.get(dirPath);
            const isSameDir = sameDirEnvs !== undefined && sameDirEnvs.length > 1;

            if (isSameDir) {
                return {
                    env,
                    parts: [...dirParts, execName],
                    isBinDir: false,
                    depth: 1,
                    currentSuffix: execName,
                };
            }

            const lastDir = dirParts[dirParts.length - 1] || '';
            const isBin = lastDir.toLowerCase() === 'bin' || lastDir.toLowerCase() === 'scripts';
            if (isBin) {
                const parentOfLast = dirParts.length >= 2 ? dirParts[dirParts.length - 2] : '';
                return {
                    env,
                    parts: dirParts,
                    isBinDir: true,
                    depth: 1,
                    currentSuffix: parentOfLast ? `${parentOfLast}/${lastDir}` : lastDir,
                };
            }

            return {
                env,
                parts: dirParts,
                isBinDir: false,
                depth: 1,
                currentSuffix: lastDir,
            };
        });

        // Iteratively resolve collisions by expanding depth for colliding items
        let hasCollisions = true;
        let iteration = 0;
        const maxIterations = 20;

        while (hasCollisions && iteration < maxIterations) {
            iteration++;
            const counts = new Map<string, number>();
            for (const item of items) {
                counts.set(item.currentSuffix, (counts.get(item.currentSuffix) ?? 0) + 1);
            }

            hasCollisions = false;
            for (const item of items) {
                if ((counts.get(item.currentSuffix) ?? 0) > 1) {
                    hasCollisions = true;
                    const maxParts = item.parts.length;
                    const neededCount = item.isBinDir ? item.depth + 2 : item.depth + 1;
                    if (neededCount <= maxParts) {
                        item.depth++;
                        item.currentSuffix = item.parts.slice(-neededCount).join('/');
                    }
                }
            }
        }

        // If identical collisions still remain after exhausting all ancestors (e.g. duplicate paths),
        // ensure unique suffixes deterministically
        const finalCounts = new Map<string, number>();
        for (const item of items) {
            finalCounts.set(item.currentSuffix, (finalCounts.get(item.currentSuffix) ?? 0) + 1);
        }

        const seenCounts = new Map<string, number>();
        for (const item of items) {
            if ((finalCounts.get(item.currentSuffix) ?? 0) > 1) {
                const seen = (seenCounts.get(item.currentSuffix) ?? 0) + 1;
                seenCounts.set(item.currentSuffix, seen);
                suffixes.set(item.env.envId.id, `${item.currentSuffix} (${seen})`);
            } else {
                suffixes.set(item.env.envId.id, item.currentSuffix);
            }
        }
    }

    return suffixes;
}

export class EnvManagerView implements TreeDataProvider<EnvTreeItem>, Disposable {
    private treeView: TreeView<EnvTreeItem>;
    private treeDataChanged: EventEmitter<EnvTreeItem | EnvTreeItem[] | null | undefined> = new EventEmitter<
        EnvTreeItem | EnvTreeItem[] | null | undefined
    >();
    private revealMap = new Map<string, PythonEnvTreeItem>();
    private managerViews = new Map<string, EnvManagerTreeItem>();
    private groupViews = new Map<string, PythonGroupEnvTreeItem>();
    private selected: Map<string, string> = new Map();
    private disposables: Disposable[] = [];

    public constructor(
        public providers: EnvironmentManagers,
        private stateManager: ITemporaryStateManager,
    ) {
        this.treeView = createTreeView<EnvTreeItem>('env-managers', {
            treeDataProvider: this,
        });

        this.disposables.push(
            new Disposable(() => {
                this.revealMap.clear();
                this.managerViews.clear();
                this.groupViews.clear();
                this.selected.clear();
            }),
            this.treeView,
            this.treeDataChanged,
            this.providers.onDidChangeEnvironments((e: InternalDidChangeEnvironmentsEventArgs) => {
                this.onDidChangeEnvironments(e);
            }),
            this.providers.onDidChangeEnvironmentManager((m: DidChangeEnvironmentManagerEventArgs) => {
                this.onDidChangeEnvironmentManager(m);
            }),

            this.providers.onDidChangePackages((p: InternalDidChangePackagesEventArgs) => {
                this.onDidChangePackages(p);
            }),
            this.providers.onDidChangePackageManager((p: DidChangePackageManagerEventArgs) => {
                this.onDidChangePackageManager(p);
            }),
            this.providers.onDidChangeProjectPackageManager(() => {
                this.fireDataChanged(undefined);
            }),
        );

        this.disposables.push(
            this.stateManager.onDidChangeState(({ itemId }) => {
                const view = this.revealMap.get(itemId);
                if (view) {
                    this.fireDataChanged(view);
                }
            }),
        );
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }

    private debouncedFireDataChanged = createSimpleDebounce(500, () => this.treeDataChanged.fire(undefined));
    private fireDataChanged(item: EnvTreeItem | EnvTreeItem[] | null | undefined) {
        if (item) {
            this.treeDataChanged.fire(item);
        } else {
            this.debouncedFireDataChanged.trigger();
        }
    }

    onDidChangeTreeData: Event<void | EnvTreeItem | EnvTreeItem[] | null | undefined> = this.treeDataChanged.event;

    getTreeItem(element: EnvTreeItem): TreeItem | Thenable<TreeItem> {
        if (element.kind === EnvTreeItemKind.environment && element instanceof PythonEnvTreeItem) {
            const itemId = element.environment.envId.id;
            const currentContext = element.treeItem.contextValue ?? '';
            element.treeItem.contextValue = this.stateManager.updateContextValue(
                itemId,
                currentContext,
                ENV_STATE_KEYS,
            );
        }
        return element.treeItem;
    }

    async getChildren(element?: EnvTreeItem | undefined): Promise<EnvTreeItem[] | undefined> {
        if (!element) {
            const views: EnvTreeItem[] = [];
            this.managerViews.clear();
            this.groupViews.clear();
            this.providers.managers.forEach((m) => {
                const view = new EnvManagerTreeItem(m);
                views.push(view);
                this.managerViews.set(m.id, view);
            });
            return views;
        }

        if (element.kind === EnvTreeItemKind.manager) {
            const manager = (element as EnvManagerTreeItem).manager;
            const views: EnvTreeItem[] = [];
            const envs = await manager.getEnvironments('all');
            const nonGroupedEnvs = envs.filter((e) => !e.group);
            const disambiguationSuffixes = computeDisambiguationSuffixes(nonGroupedEnvs);
            nonGroupedEnvs.forEach((env) => {
                const suffix = disambiguationSuffixes.get(env.envId.id);
                const view = new PythonEnvTreeItem(
                    env,
                    element as EnvManagerTreeItem,
                    this.selected.get(env.envId.id),
                    suffix,
                );
                views.push(view);
                this.revealMap.set(env.envId.id, view);
            });

            const groups: string[] = [];
            const groupObjects: (string | EnvironmentGroupInfo)[] = [];
            envs.filter((e) => e.group).forEach((env) => {
                const name =
                    env.group && typeof env.group === 'string' ? env.group : (env.group as EnvironmentGroupInfo).name;
                if (name && !groups.includes(name)) {
                    groups.push(name);
                    groupObjects.push(env.group as EnvironmentGroupInfo);
                }
            });

            groupObjects.forEach((group) => {
                const groupView = new PythonGroupEnvTreeItem(element as EnvManagerTreeItem, group);
                const groupName = typeof group === 'string' ? group : group.name;
                this.groupViews.set(`${manager.id}:${groupName}`, groupView);
                views.push(groupView);
            });

            if (views.length === 0) {
                views.push(new NoPythonEnvTreeItem(element as EnvManagerTreeItem));
            }
            return views;
        }

        if (element.kind === EnvTreeItemKind.environmentGroup) {
            const groupItem = element as PythonGroupEnvTreeItem;
            const manager = groupItem.parent.manager;
            const views: EnvTreeItem[] = [];
            const envs = await manager.getEnvironments('all');
            const groupName =
                typeof groupItem.group === 'string' ? groupItem.group : (groupItem.group as EnvironmentGroupInfo).name;
            const grouped = envs.filter((e) => {
                if (e.group) {
                    const name =
                        e.group && typeof e.group === 'string' ? e.group : (e.group as EnvironmentGroupInfo).name;
                    return name === groupName;
                }
                return false;
            });

            const groupDisambiguationSuffixes = computeDisambiguationSuffixes(grouped);
            grouped.forEach((env) => {
                const suffix = groupDisambiguationSuffixes.get(env.envId.id);
                const view = new PythonEnvTreeItem(env, groupItem, this.selected.get(env.envId.id), suffix);
                views.push(view);
                this.revealMap.set(env.envId.id, view);
            });

            return views;
        }

        if (element.kind === EnvTreeItemKind.environment) {
            const pythonEnvItem = element as PythonEnvTreeItem;
            const { environment } = pythonEnvItem;
            const pkgManager = this.providers.getPackageManager(environment);
            const parent = element as PythonEnvTreeItem;
            const views: EnvTreeItem[] = [];

            if (pkgManager) {
                await pkgManager.refresh(environment);
                const packages = await pkgManager.getPackages(environment);
                if (packages && packages.length > 0) {
                    views.push(
                        ...packages
                            .sort((a, b) => (a.isTransitive === b.isTransitive ? 0 : a.isTransitive ? 1 : -1))
                            .map((p) => new PackageTreeItem(p, parent, pkgManager)),
                    );
                } else {
                    views.push(new EnvInfoTreeItem(parent, ProjectViews.noPackages));
                }
            } else {
                views.push(new EnvInfoTreeItem(parent, ProjectViews.noPackageManager));
            }

            return views;
        }
    }

    getParent(element: EnvTreeItem): ProviderResult<EnvTreeItem> {
        return element.parent;
    }

    /**
     * Reveals and focuses on the given environment in the Environment Managers view.
     *
     * @param environment - The Python environment to reveal
     */
    async reveal(environment?: PythonEnvironment): Promise<void> {
        if (!environment) {
            return;
        }

        const manager = this.providers.getEnvironmentManager(environment);
        if (!manager) {
            return;
        }

        if (!this.managerViews.has(manager.id)) {
            await this.getChildren(undefined);
        }

        const managerView = this.managerViews.get(manager.id);
        if (!managerView) {
            return;
        }

        const groupName = typeof environment.group === 'string' ? environment.group : environment.group?.name;
        if (groupName) {
            if (!this.groupViews.has(`${manager.id}:${groupName}`)) {
                await this.getChildren(managerView);
            }

            const groupView = this.groupViews.get(`${manager.id}:${groupName}`);
            if (groupView) {
                await this.getChildren(groupView);
            }
        } else {
            await this.getChildren(managerView);
        }

        const view = this.revealMap.get(environment.envId.id);
        if (view && this.treeView.visible) {
            await this.treeView.reveal(view, { expand: false, focus: true, select: true });
        }
    }

    private onDidChangeEnvironmentManager(_args: DidChangeEnvironmentManagerEventArgs) {
        this.fireDataChanged(undefined);
    }

    private onDidChangeEnvironments(args: InternalDidChangeEnvironmentsEventArgs) {
        this.fireDataChanged(this.managerViews.get(args.manager.id));
    }

    private onDidChangePackages(args: InternalDidChangePackagesEventArgs) {
        const view = Array.from(this.revealMap.values()).find(
            (v) => v.environment.envId.id === args.environment.envId.id,
        );
        if (view) {
            this.fireDataChanged(view);
        }
    }

    private onDidChangePackageManager(_args: DidChangePackageManagerEventArgs) {
        // Since we removed the packageRoots level, just refresh all environments
        // This is a simplified approach that isn't as targeted but ensures packages get refreshed
        this.fireDataChanged(undefined);
    }

    public environmentChanged(e: DidChangeEnvironmentEventArgs) {
        const views = [];
        if (e.old) {
            this.selected.delete(e.old.envId.id);
            const view: EnvTreeItem | undefined = this.revealMap.get(e.old.envId.id);
            if (view) {
                views.push(view);
            }
        }
        if (e.new) {
            this.selected.set(e.new.envId.id, e.uri === undefined ? 'global' : e.uri.fsPath);
            const view: EnvTreeItem | undefined = this.revealMap.get(e.new.envId.id);
            if (view && !views.includes(view)) {
                views.push(view);
            }
        }
        this.fireDataChanged(views);
    }
}
