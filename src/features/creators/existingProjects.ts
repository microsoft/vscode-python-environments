import * as path from 'path';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { ProjectCreatorString } from '../../common/localize';
import { showOpenDialog, showWarningMessage } from '../../common/window.apis';
import { PythonProjectManager } from '../../internal.api';
import { traceInfo } from '../../common/logging';

export class ExistingProjects implements PythonProjectCreator {
    public readonly name = 'existingProjects';
    public readonly displayName = ProjectCreatorString.addExistingProjects;

    constructor(private readonly pm: PythonProjectManager) {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | PythonProject[] | undefined> {
        const results = await showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            filters: {
                python: ['py'],
            },
            title: ProjectCreatorString.selectFilesOrFolders,
        });

        if (!results || results.length === 0) {
            return;
        }

        // do we have any limitations that need to be applied here?
        // like selected folder not child of workspace folder?

        const filtered = results.filter((uri) => {
            const p = this.pm.get(uri);
            if (p) {
                // Skip this project if there's already a project registered with exactly the same path
                const np = path.normalize(p.uri.fsPath);
                const nf = path.normalize(uri.fsPath);
                return np !== nf;
            }
            return true;
        });

        if (filtered.length === 0) {
            // No new projects found that are not already in the project manager
            traceInfo('All discovered projects are already registered in the project manager');
            setImmediate(() => {
                showWarningMessage('No new projects found');
            });
            return;
        }

        return filtered.map((r) => ({
            name: path.basename(r.fsPath),
            uri: r,
        }));
    }
}
