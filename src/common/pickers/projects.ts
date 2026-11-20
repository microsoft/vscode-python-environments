import path from 'path';
import { QuickPickItem } from 'vscode';
import { PythonProject } from '../../api';
import { showQuickPick, showQuickPickWithButtons } from '../window.apis';
import { Pickers } from '../localize';
import { normalizePath } from '../utils/pathUtils';

interface ProjectQuickPickItem extends QuickPickItem {
    project: PythonProject;
}

export interface PickProjectManyOptions {
    /** Whether to show the Quick Pick back button. */
    showBackButton?: boolean;
    /** Whether to show the picker instead of auto-selecting when there is one project. */
    showPickerForSingleProject?: boolean;
    /** Projects that should be checked when the picker opens. */
    selectedProjects?: readonly PythonProject[];
}

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

/**
 * Prompts for zero or more projects, optionally preselecting existing project choices.
 *
 * The boolean overload is retained for existing callers that only configure back navigation.
 */
export async function pickProjectMany(
    projects: readonly PythonProject[],
    showBackButtonOrOptions?: boolean | PickProjectManyOptions,
): Promise<PythonProject[] | undefined> {
    const options =
        typeof showBackButtonOrOptions === 'boolean'
            ? { showBackButton: showBackButtonOrOptions }
            : showBackButtonOrOptions;
    if (projects.length > 1 || (projects.length === 1 && options?.showPickerForSingleProject)) {
        const selectedProjectPaths = new Set(
            options?.selectedProjects?.map((project) => normalizePath(path.resolve(project.uri.fsPath))) ?? [],
        );
        const items: ProjectQuickPickItem[] = projects.map((pw) => ({
            label: path.basename(pw.uri.fsPath),
            description: pw.uri.fsPath,
            project: pw,
        }));
        const item = await showQuickPickWithButtons(items, {
            placeHolder: Pickers.Project.selectProjects,
            ignoreFocusOut: true,
            canPickMany: true,
            showBackButton: options?.showBackButton,
            selected: items.filter((item) =>
                selectedProjectPaths.has(normalizePath(path.resolve(item.project.uri.fsPath))),
            ),
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
