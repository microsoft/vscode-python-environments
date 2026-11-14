import * as path from 'path';
import { Uri, WorkspaceFolder } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { ProjectCreatorString } from '../../common/localize';
import { traceInfo, traceWarn } from '../../common/logging';
import { showErrorMessage, showQuickPickWithButtons, showWarningMessage } from '../../common/window.apis';
import { findFiles, getWorkspaceFolders } from '../../common/workspace.apis';
import type { EnvironmentManagers } from '../envManagers';
import {
    PythonProjectManager,
    PythonProjectsImpl,
} from '../projectManager';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';

export interface DiscoveredProject {
    readonly label: string;
    readonly description: string;
    readonly uri: Uri;
}

function getUniqueUri(uris: Uri[]): DiscoveredProject[] {
    const files = uris.map((uri) => uri.fsPath).sort();
    const dirs: Map<string, string> = new Map();
    files.forEach((file) => {
        const dir = path.dirname(file);
        if (dirs.has(dir)) {
            return;
        }
        dirs.set(dir, file);
    });
    return Array.from(dirs.entries())
        .map(([dir, file]) => ({
            label: path.basename(dir),
            description: file,
            uri: Uri.file(dir),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A marker is already registered when its path, or the directory that contains it,
 * is the project the manager resolves for that file.
 */
function isAlreadyRegistered(pm: PythonProjectManager, uri: Uri): boolean {
    const project = pm.get(uri);
    if (!project) {
        return false;
    }
    const registeredPath = normalizePath(project.uri.fsPath);
    const markerPath = normalizePath(uri.fsPath);
    const markerDirectory = path.dirname(markerPath);
    return registeredPath === markerPath || registeredPath === markerDirectory;
}

async function pickProjects(uris: Uri[]): Promise<Uri[] | undefined> {
    const items = getUniqueUri(uris);

    const selected = await showQuickPickWithButtons(items, {
        canPickMany: true,
        ignoreFocusOut: true,
        placeHolder: ProjectCreatorString.selectProjects,
        showBackButton: true,
    });

    if (Array.isArray(selected)) {
        return selected.map((s) => s.uri);
    } else if (selected) {
        return [selected.uri];
    }

    return undefined;
}

export class AutoFindProjects implements PythonProjectCreator {
    public readonly name = 'autoProjects';
    public readonly displayName = ProjectCreatorString.autoFindProjects;
    public readonly description = ProjectCreatorString.autoFindProjectsDescription;

    supportsQuickCreate = true;

    constructor(
        private readonly pm: PythonProjectManager,
        private readonly envManagers: EnvironmentManagers,
    ) {}

    /**
     * Returns selected environment prefixes inside an open workspace folder.
     * Lookup failures are logged and skipped.
     */
    private async getSelectedEnvironmentPrefixes(folders: readonly WorkspaceFolder[]): Promise<string[]> {
        const prefixes = await Promise.all(
            folders.map(async (folder) => {
                try {
                    const environment = await this.envManagers.getEnvironment(folder.uri);
                    const prefix = environment?.sysPrefix;
                    return prefix &&
                        path.isAbsolute(prefix) &&
                        folders.some((workspaceFolder) => isSameOrParentPath(workspaceFolder.uri.fsPath, prefix))
                        ? prefix
                        : undefined;
                } catch (ex) {
                    traceWarn(`Auto Find: failed to get environment for ${folder.uri.fsPath}`, ex);
                    return undefined;
                }
            }),
        );
        return prefixes.filter((prefix): prefix is string => !!prefix);
    }

    /**
     * Marker files Auto Find would consider, excluding those inside a selected environment.
     * Does not prompt or notify.
     */
    private async discoverMarkerFiles(): Promise<Uri[]> {
        const found = await findFiles('**/{pyproject.toml,setup.py}', '**/.venv/**');
        // Exclude markers inside selected environments (e.g. installed packages in a custom-named venv).
        const folders = found && found.length > 0 ? getWorkspaceFolders() ?? [] : [];
        const prefixes = await this.getSelectedEnvironmentPrefixes(folders);
        return (
            found?.filter(
                (uri) =>
                    !prefixes.some(
                        (prefix) =>
                            isSameOrParentPath(prefix, uri.fsPath) &&
                            !folders.some(
                                (folder) =>
                                    isSameOrParentPath(prefix, folder.uri.fsPath) &&
                                    isSameOrParentPath(folder.uri.fsPath, uri.fsPath),
                            ),
                    ),
            ) ?? []
        );
    }

    /**
     * Project directories that are not already registered.
     * Does not prompt or notify, including when nothing is found.
     */
    async findNewProjects(): Promise<DiscoveredProject[]> {
        const files = await this.discoverMarkerFiles();
        return getUniqueUri(files.filter((uri) => !isAlreadyRegistered(this.pm, uri)));
    }

    /**
     * Registers project directories previously returned by {@link findNewProjects}.
     */
    addDiscoveredProjects(uris: readonly Uri[]): PythonProject[] {
        const projects = uris.map((uri) => new PythonProjectsImpl(path.basename(uri.fsPath), uri)) as PythonProject[];
        this.pm.add(projects);
        return projects;
    }

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | PythonProject[] | undefined> {
        const files = await this.discoverMarkerFiles();
        if (files.length === 0) {
            setImmediate(() => {
                showErrorMessage(ProjectCreatorString.noProjectsFound);
            });
            return;
        }

        const filtered = files.filter((uri) => !isAlreadyRegistered(this.pm, uri));

        if (filtered.length === 0) {
            // No new projects found that are not already in the project manager
            traceInfo(
                `All selected resources are already registered in the project manager: ${files
                    .map((uri) => uri.fsPath)
                    .join(', ')}`,
            );
            setImmediate(() => {
                if (files.length === 1) {
                    showWarningMessage(`${files[0].fsPath} already exists as project.`);
                } else {
                    showWarningMessage('Selected resources already exist as projects.');
                }
            });
            return;
        }

        traceInfo(`Found ${filtered.length} new potential projects that aren't already registered`);

        const projectUris = await pickProjects(filtered);
        if (!projectUris || projectUris.length === 0) {
            // User cancelled the selection.
            traceInfo('User cancelled project selection.');
            return;
        }
        return this.addDiscoveredProjects(projectUris);
    }
}
