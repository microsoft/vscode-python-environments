import { Uri, workspace } from 'vscode';
import { isWindows } from '../../managers/common/utils';

export function checkUri(scope?: Uri | Uri[] | string): Uri | Uri[] | string | undefined {
    if (scope instanceof Uri) {
        if (scope.scheme === 'vscode-notebook-cell') {
            workspace.notebookDocuments.find((doc) => {
                if (doc.uri.toString() === scope.toString()) {
                    return doc;
                }
            });
            return scope;
        }
    }
    if (Array.isArray(scope)) {
        return scope.map((item) => {
            return checkUri(item) as Uri;
        });
    }
    return scope;
}

export function normalizePath(path: string): string {
    const path1 = path.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}
