import { MarkdownString, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
// import { runInBackground } from '../execution/runInBackground';

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = 'newPackage';
    public readonly displayName = 'Package';
    public readonly description = 'Create a new Python package';
    public readonly tooltip = new MarkdownString('Create a new Python package');

    constructor() {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // show notification that the package creation was selected than return undefined
        window.showInformationMessage('Creating a new Python package...');
        return undefined;
    }
}
