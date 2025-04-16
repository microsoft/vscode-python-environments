import { MarkdownString, window } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';

export class NewScriptProject implements PythonProjectCreator {
    public readonly name = 'newScript';
    public readonly displayName = 'Project';
    public readonly description = 'Create a new Python project';
    public readonly tooltip = new MarkdownString('Create a new Python project');

    constructor() {}

    async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        // show notification that the script creation was selected than return undefined
        window.showInformationMessage('Creating a new Python project...');
        return undefined;
    }
}
