import { LogOutputChannel, MarkdownString, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { PythonProjectManager } from '../../internal.api';
// import { runInBackground } from '../execution/runInBackground';

export class NewPackageProject implements PythonProjectCreator {
    public readonly name = 'newPackage';
    public readonly displayName = 'New Python Package';
    public readonly description = 'Create a new Python package project';
    public readonly tooltip = new MarkdownString('Create a new Python package with proper structure');

    constructor(private readonly pm: PythonProjectManager, private log: LogOutputChannel) {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // show notification that the pkg creation was selected than return undefined
        window.showInformationMessage('Creating a new Python package project...');
        return undefined;
    }
}
