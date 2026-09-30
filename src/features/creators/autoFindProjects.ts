import * as path from 'path';
import { Uri, WorkspaceFolder } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { SYSTEM_MANAGER_ID } from '../../common/constants';
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

type SelectedEnvironmentPrefix = { prefix: string; managerId: string };

function getUniqueUri(uris: Uri[]): {
    label: string;
    description: string;
    uri: Uri;
}[] {
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
    private async getSelectedEnvironmentPrefixes(folders: readonly WorkspaceFolder[]): Promise<SelectedEnvironmentPrefix[]> {
        const prefixes = await Promise.all(
            folders.map(async (folder) => {
                try {
                    const environment = await this.envManagers.getEnvironment(folder.uri);
                    const prefix = environment?.sysPrefix;
                    return prefix &&
                        path.isAbsolute(prefix) &&
                        folders.some((workspaceFolder) => isSameOrParentPath(workspaceFolder.uri.fsPath, prefix))
                        ? { prefix, managerId: environment.envId.managerId }
                        : undefined;
                } catch (ex) {
                    traceWarn(`Auto Find: failed to get environment for ${folder.uri.fsPath}`, ex);
                    return undefined;
                }
            }),
        );
        return prefixes.filter((prefix): prefix is SelectedEnvironmentPrefix => !!prefix);
    }

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | PythonProject[] | undefined> {
        const found = await findFiles('**/{pyproject.toml,setup.py}', '**/.venv/**');
        // Exclude markers inside selected environments (e.g. installed packages in a custom-named venv).
        const folders = found && found.length > 0 ? getWorkspaceFolders() ?? [] : [];
        const prefixes = await this.getSelectedEnvironmentPrefixes(folders);
        const files = found?.filter(
            (uri) =>
                !prefixes.some(
                    ({ prefix, managerId }) =>
                        isSameOrParentPath(prefix, uri.fsPath) &&
                        (managerId !== SYSTEM_MANAGER_ID ||
                            path
                                .relative(prefix, uri.fsPath)
                                .split(path.sep)
                                .some((part) => ['site-packages', 'dist-packages'].includes(normalizePath(part)))) &&
                        !folders.some(
                            (folder) =>
                                isSameOrParentPath(prefix, folder.uri.fsPath) &&
                                isSameOrParentPath(folder.uri.fsPath, uri.fsPath),
                        ),
                ),
        );
        if (!files || files.length === 0) {
            setImmediate(() => {
                showErrorMessage('No projects found');
            });
            return;
        }

        const filtered = files.filter((uri) => {
            const p = this.pm.get(uri);
            if (p) {
                // Skip this project if:
                // 1. There's already a project registered with exactly the same path
                // 2. There's already a project registered with this project's parent directory path
                const np = normalizePath(p.uri.fsPath);
                const nf = normalizePath(uri.fsPath);
                const nfp = path.dirname(nf);
                return np !== nf && np !== nfp;
            }
            return true;
        });

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
        const projects = projectUris.map(
            (uri) => new PythonProjectsImpl(path.basename(uri.fsPath), uri),
        ) as PythonProject[];
        // Add the projects to the project manager
        this.pm.add(projects);
        return projects;
    }
}
