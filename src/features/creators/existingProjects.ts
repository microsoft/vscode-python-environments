import * as path from 'path';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { ProjectCreatorString } from '../../common/localize';
import { showOpenDialog } from '../../common/window.apis';

export class ExistingProjects implements PythonProjectCreator {
    public readonly name = 'existingProjects';
    public readonly displayName = ProjectCreatorString.addExistingProjects;

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

        return results.map((r) => ({
            name: path.basename(r.fsPath),
            uri: r,
        }));
    }
}
