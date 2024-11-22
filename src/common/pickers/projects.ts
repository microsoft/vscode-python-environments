import path from 'path';
import { QuickPickItem } from 'vscode';
import { PythonProject } from '../../api';
import { showQuickPick, showQuickPickWithButtons } from '../window.apis';

interface ProjectQuickPickItem extends QuickPickItem {
    project: PythonProject;
}

export async function pickProject(projects: ReadonlyArray<PythonProject>): Promise<PythonProject | undefined> {
    if (projects.length > 1) {
        const items: ProjectQuickPickItem[] = projects.map((pw) => ({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            project: pw,
        }));
        const item = await showQuickPick(items, {
            placeHolder: 'Select a project, folder or script',
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
            placeHolder: 'Select a project, folder or script',
            ignoreFocusOut: true,
            canPickMany: true,
            showBackButton: showBackButton,
        });
        if (Array.isArray(item)) {
            return item.map((p) => p.project);
        }
    } else if (projects.length === 1) {
        return [...projects];
    }
    return undefined;
}
