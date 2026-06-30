import { PythonProject } from '../../api';
import { getWorkspaceFolder } from '../../common/workspace.apis';
import { normalizePath } from '../../common/utils/pathUtils';

export function removable(project: PythonProject): boolean {
    const workspace = getWorkspaceFolder(project.uri);
    if (workspace) {
        // If the project path is same as the workspace path, then we cannot remove the project.
        return normalizePath(workspace?.uri.fsPath) !== normalizePath(project.uri.fsPath);
    }
    return true;
}
