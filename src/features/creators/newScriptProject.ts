import { MarkdownString, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { PythonProjectManager } from '../../internal.api';

export class NewScriptProject implements PythonProjectCreator {
    public readonly name = 'newScript';
    public readonly displayName = 'New Python Script';
    public readonly description = 'Create a new Python script project';
    public readonly tooltip = new MarkdownString('Create a new Python script with basic structure');

    constructor(private readonly pm: PythonProjectManager) {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // show notification that the script creation was selected than return undefined
        window.showInformationMessage('Creating a new Python script project...');
        return undefined;
    }
}
