import { LogOutputChannel, MarkdownString, ProgressLocation, window } from 'vscode';
import {
    IconPath,
    PythonEnvironmentApi,
    PythonProject,
    PythonProjectCreator,
    PythonProjectCreatorOptions,
} from '../../api';
import { runUV } from './helpers';
import { pickProject } from '../../common/pickers/projects';

export class UvProjectCreator implements PythonProjectCreator {
    constructor(private readonly api: PythonEnvironmentApi, private log: LogOutputChannel) {
        this.name = 'uv';
        this.displayName = 'UV Init';
        this.description = 'Initialize a Python project using UV';
        this.tooltip = new MarkdownString('Initialize a Python Project using `uv init`');
    }

    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
    readonly iconPath?: IconPath;

    public async create(_option?: PythonProjectCreatorOptions): Promise<PythonProject | undefined> {
        const projectName = await window.showInputBox({
            prompt: 'Enter the name of the project',
            value: 'myproject',
            ignoreFocusOut: true,
        });

        if (!projectName) {
            return;
        }

        const projectPath = await pickProject(this.api.getPythonProjects());

        if (!projectPath) {
            return;
        }

        const projectType = (
            await window.showQuickPick(
                [
                    { label: 'Library', description: 'Create a Python library project', detail: '--lib' },
                    { label: 'Application', description: 'Create a Python application project', detail: '--app' },
                ],
                {
                    placeHolder: 'Select the type of project to create',
                    ignoreFocusOut: true,
                },
            )
        )?.detail;

        if (!projectType) {
            return;
        }

        // --package        Set up the project to be built as a Python package
        // --no-package     Do not set up the project to be built as a Python package
        // --no-readme      Do not create a `README.md` file
        // --no-pin-python  Do not create a `.python-version` file for the project
        // --no-workspace   Avoid discovering a workspace and create a standalone project
        const projectOptions =
            (
                await window.showQuickPick(
                    [
                        {
                            label: 'Package',
                            description: 'Set up the project to be built as a Python package',
                            detail: '--package',
                        },
                        {
                            label: 'No Package',
                            description: 'Do not set up the project to be built as a Python package',
                            detail: '--no-package',
                        },
                        { label: 'No Readme', description: 'Do not create a `README.md` file', detail: '--no-readme' },
                        {
                            label: 'No Pin Python',
                            description: 'Do not create a `.python-version` file for the project',
                            detail: '--no-pin-python',
                        },
                        {
                            label: 'No Workspace',
                            description: 'Avoid discovering a workspace and create a standalone project',
                            detail: '--no-workspace',
                        },
                    ],
                    {
                        placeHolder: 'Select the options for the project',
                        ignoreFocusOut: true,
                        canPickMany: true,
                    },
                )
            )?.map((item) => item.detail) ?? [];
        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: 'Creating project',
                },
                async () => {
                    await runUV(
                        ['init', projectType, '--name', projectName, ...projectOptions, projectPath.uri.fsPath],
                        undefined,
                        this.log,
                    );
                },
            );
        } catch {
            const result = await window.showErrorMessage('Failed to create project', 'View Output');
            if (result === 'View Output') {
                this.log.show();
            }
            return;
        }

        return undefined;
    }
}
