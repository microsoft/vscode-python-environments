import { NotebookCell, NotebookDocument, Uri, workspace } from 'vscode';
import { isWindows } from '../../managers/common/utils';

export function checkUri(scope?: Uri | Uri[] | string): Uri | Uri[] | string | undefined {
    if (!scope) {
        return undefined;
    }

    if (Array.isArray(scope)) {
        // if the scope is an array, all items must be Uri, check each item
        return scope.map((item) => {
            const s = checkUri(item);
            if (s instanceof Uri) {
                return s;
            }
            throw new Error('Invalid entry, expected Uri.');
        });
    }

    if (scope instanceof Uri) {
        if (scope.scheme === 'vscode-notebook-cell') {
            const matchingDoc = workspace.notebookDocuments.find((doc) => findCell(scope, doc));
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
    return notebook.getCells().find((cell) => {
        return isEqual(cell.document.uri, cellUri);
    });
}
function isEqual(uri1: Uri | undefined, uri2: Uri | undefined): boolean {
    if (uri1 === uri2) {
        return true;
    }
    if (!uri1 || !uri2) {
        return false;
    }
    return getComparisonKey(uri1) === getComparisonKey(uri2);
}

function getComparisonKey(uri: Uri): string {
    return uri
        .with({
            path: ignorePathCasing(uri) ? uri.path.toLowerCase() : undefined,
            fragment: undefined,
        })
        .toString();
}

function ignorePathCasing(_uri: Uri): boolean {
    return true;
}

export function normalizePath(path: string): string {
    const path1 = path.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}
