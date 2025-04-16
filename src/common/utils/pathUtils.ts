import { NotebookCell, NotebookDocument, Uri, workspace } from 'vscode';
import { isWindows } from '../../managers/common/utils';

export function checkUri(scope?: Uri | Uri[] | string): Uri | Uri[] | string | undefined {
    if (!scope) {
        return undefined;
    }

    if (Array.isArray(scope)) {
        return scope.map((item) => checkUri(item) as Uri);
    }

    if (scope instanceof Uri) {
        if (scope.scheme === 'vscode-notebook-cell') {
            // If the scope is a cell Uri, we need to find the notebook document it belongs to.
            const matchingDoc = workspace.notebookDocuments.find((doc) => {
                const cell = findCell(scope, doc);
                return cell !== undefined;
            });
            // If we find a matching notebook document, return the Uri of the cell.
            return matchingDoc ? matchingDoc.uri : scope;
        }
    }
    return scope;
}

/**
 * Find a notebook document by cell Uri.
 */
export function findCell(cellUri: Uri, notebook: NotebookDocument): NotebookCell | undefined {
    // Fragment is not unique to a notebook, hence ensure we compare the path as well.
    const index = notebook
        .getCells()
        .findIndex(
            (cell) =>
                isEqual(cell.document.uri, cellUri) ||
                (cell.document.uri.fragment === cellUri.fragment && cell.document.uri.path === cellUri.path),
        );
    if (index !== -1) {
        return notebook.getCells()[index];
    }
}

function isEqual(a: Uri, b: Uri): boolean {
    return a.toString() === b.toString();
}

export function normalizePath(path: string): string {
    const path1 = path.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}
