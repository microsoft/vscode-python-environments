import * as path from 'path';
import { Uri } from 'vscode';
import { showQuickPickWithButtons } from '../../common/window.apis';
import { ProjectCreatorString } from '../../common/localize';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { PythonProjectManager } from '../../internal.api';
import { showErrorMessage } from '../../common/errors/utils';
import { findFiles } from '../../common/workspace.apis';

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

    constructor(private readonly pm: PythonProjectManager) {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | PythonProject[] | undefined> {
        const files = await findFiles('**/{pyproject.toml,setup.py}');
        if (!files || files.length === 0) {
            setImmediate(() => {
                showErrorMessage('No projects found');
            });
            return;
        }

        const filtered = files.filter((uri) => {
            const p = this.pm.get(uri);
            if (p) {
                // If there ia already a project with the same path, skip it.
                // If there is a project with the same parent path, skip it.
                const np = path.normalize(p.uri.fsPath);
                const nf = path.normalize(uri.fsPath);
                const nfp = path.dirname(nf);
                return np !== nf && np !== nfp;
            }
            return true;
        });

        if (filtered.length === 0) {
            return;
        }

        const projects = await pickProjects(filtered);
        if (!projects || projects.length === 0) {
            return;
        }

        return projects.map((uri) => ({
            name: path.basename(uri.fsPath),
            uri,
        }));
    }
}
