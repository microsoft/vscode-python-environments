import * as path from 'path';
import { Disposable, Uri, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../api';
import { ProjectCreators } from '../internal.api';
import { showErrorMessage } from '../common/errors/utils';
import { findFiles } from '../common/workspace.apis';
import { showOpenDialog } from '../common/window.apis';

export class ProjectCreatorsImpl implements ProjectCreators {
    private _creators: PythonProjectCreator[] = [];

    registerPythonProjectCreator(creator: PythonProjectCreator): Disposable {
        this._creators.push(creator);
        return new Disposable(() => {
            this._creators = this._creators.filter((item) => item !== creator);
        });
    }
    getProjectCreators(): PythonProjectCreator[] {
        return this._creators;
    }

    dispose() {
        this._creators = [];
    }
}

export function registerExistingProjectProvider(pc: ProjectCreators): Disposable {
    return pc.registerPythonProjectCreator({
        name: 'existingProjects',
        displayName: 'Add Existing Projects',

        async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | PythonProject[] | undefined> {
            const results = await showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: true,
                filters: {
                    python: ['py'],
                },
                title: 'Select a file(s) or folder(s) to add as Python projects',
            });

            if (!results || results.length === 0) {
                return;
            }

            return results.map((r) => ({
                name: path.basename(r.fsPath),
                uri: r,
            }));
        },
    });
}

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

    const selected = await window.showQuickPick(items, {
        canPickMany: true,
        ignoreFocusOut: true,
        placeHolder: 'Select the folders to add as Python projects',
    });

    return selected?.map((s) => s.uri);
}

export function registerAutoProjectProvider(pc: ProjectCreators): Disposable {
    return pc.registerPythonProjectCreator({
        name: 'autoProjects',
        displayName: 'Auto Find Projects',
        description: 'Automatically find folders with `pyproject.toml` or `setup.py` files.',

        async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | PythonProject[] | undefined> {
            const files = await findFiles('**/{pyproject.toml,setup.py}');
            if (!files || files.length === 0) {
                setImmediate(() => {
                    showErrorMessage('No projects found');
                });
                return;
            }

            const projects = await pickProjects(files);
            if (!projects || projects.length === 0) {
                return;
            }

            return projects.map((uri) => ({
                name: path.basename(uri.fsPath),
                uri,
            }));
        },
    });
}
