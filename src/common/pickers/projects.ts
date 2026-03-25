import path from 'path';
import { QuickPickItem, QuickPickItemKind, Uri } from 'vscode';
import { PythonProject } from '../../api';
import { showQuickPick, showQuickPickWithButtons } from '../window.apis';
import { Pickers } from '../localize';

interface ProjectQuickPickItem extends QuickPickItem {
    project: PythonProject;
}

export const CURRENT_FILE_ACTION = 'currentFile';
export const ADD_PROJECT_ACTION = 'addProject';

export interface CurrentFileResult {
    action: typeof CURRENT_FILE_ACTION;
    fileUri: Uri;
}

export interface AddProjectResult {
    action: typeof ADD_PROJECT_ACTION;
    fileUri: Uri;
}

export interface ProjectsResult {
    action: 'projects';
    projects: PythonProject[];
}

export type ProjectPickerResult = CurrentFileResult | AddProjectResult | ProjectsResult | undefined;

interface ActionQuickPickItem extends QuickPickItem {
    action: typeof CURRENT_FILE_ACTION | typeof ADD_PROJECT_ACTION;
    fileUri: Uri;
}

type EnrichedQuickPickItem = ProjectQuickPickItem | ActionQuickPickItem | QuickPickItem;

export async function pickProject(projects: ReadonlyArray<PythonProject>): Promise<PythonProject | undefined> {
    if (projects.length > 1) {
        const items: ProjectQuickPickItem[] = projects.map((pw) => ({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            project: pw,
        }));
        const item = await showQuickPick(items, {
            placeHolder: Pickers.Project.selectProject,
            ignoreFocusOut: true,
        });
        if (item) {
            return item.project;
        }
    } else if (projects.length === 1) {
        return projects[0];
    }
    return undefined;
}

export async function pickProjectMany(
    projects: readonly PythonProject[],
    showBackButton?: boolean,
): Promise<PythonProject[] | undefined> {
    if (projects.length > 1) {
        const items: ProjectQuickPickItem[] = projects.map((pw) => ({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            project: pw,
        }));
        const item = await showQuickPickWithButtons(items, {
            placeHolder: Pickers.Project.selectProjects,
            ignoreFocusOut: true,
            canPickMany: true,
            showBackButton: showBackButton,
        });
        if (Array.isArray(item)) {
            return item.map((p) => p.project);
        }
    } else if (projects.length === 1) {
        return [...projects];
    } else if (projects.length === 0) {
        return [];
    }
    return undefined;
}

/**
 * Shows a project picker with additional "Current File" options at the top.
 * When the active editor has a Python file, two special items are injected:
 * - "Set for current file" — scopes environment to just the active file URI
 * - "Add current file as project..." — creates a project at the file's parent directory
 *
 * @param projects - The list of existing projects to show
 * @param activeFileUri - The URI of the active Python file (if any)
 * @returns A discriminated result indicating the user's choice, or undefined if cancelled
 */
export async function pickProjectWithCurrentFile(
    projects: readonly PythonProject[],
    activeFileUri: Uri,
): Promise<ProjectPickerResult> {
    const items: EnrichedQuickPickItem[] = [];

    // Current file section
    items.push({
        label: Pickers.Project.currentFileSection,
        kind: QuickPickItemKind.Separator,
    });
    items.push({
        label: `$(file) ${Pickers.Project.setForCurrentFile}`,
        description: path.basename(activeFileUri.fsPath),
        action: CURRENT_FILE_ACTION,
        fileUri: activeFileUri,
    } as ActionQuickPickItem);
    items.push({
        label: `$(add) ${Pickers.Project.addCurrentFileAsProject}`,
        description: path.dirname(activeFileUri.fsPath),
        action: ADD_PROJECT_ACTION,
        fileUri: activeFileUri,
    } as ActionQuickPickItem);

    // Projects section
    items.push({
        label: Pickers.Project.projectsSection,
        kind: QuickPickItemKind.Separator,
    });
    for (const pw of projects) {
        items.push({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            project: pw,
        } as ProjectQuickPickItem);
    }

    const selected = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Project.selectProjects,
        ignoreFocusOut: true,
    });

    if (!selected) {
        return undefined;
    }

    if ('action' in selected) {
        const actionItem = selected as ActionQuickPickItem;
        return { action: actionItem.action, fileUri: actionItem.fileUri };
    }

    if ('project' in selected) {
        const projectItem = selected as ProjectQuickPickItem;
        return { action: 'projects', projects: [projectItem.project] };
    }

    return undefined;
}
