import { Disposable } from 'vscode';
import type { PythonProjectCreator } from '../../api';

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
