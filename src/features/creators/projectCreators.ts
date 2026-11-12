import { Disposable } from 'vscode';
import type { PythonProjectCreator } from '../../api';
import { FAST_API_CREATOR_NAME, FAST_API_PROJECT_TYPE } from './newFastApiProject';

/**
 * Maps a quick-create project type to the registered creator name.
 * @param projectType - Value passed to `python-envs.createNewProjectFromTemplate`.
 * @returns The creator `name` to look up, or `undefined` when the type is unknown.
 */
export function creatorNameForQuickCreateProjectType(projectType: string): string | undefined {
    switch (projectType) {
        case 'python-package':
            return 'newPackage';
        case 'python-script':
            return 'newScript';
        case FAST_API_PROJECT_TYPE:
            return FAST_API_CREATOR_NAME;
        default:
            return undefined;
    }
}

export interface ProjectCreators extends Disposable {
    registerPythonProjectCreator(creator: PythonProjectCreator): Disposable;
    getProjectCreators(): PythonProjectCreator[];
}

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
