import { Uri } from 'vscode';
import { isWindows } from '../../managers/common/utils';

export function convertNotebookCellUriToNotebookUri(uri: Uri): Uri {
    if (uri.scheme !== 'vscode-notebook-cell') {
        throw new Error('URI is not of scheme vscode-notebook-cell');
    }
    return Uri.from({
        scheme: 'vscode-notebook',
        path: uri.path,
        authority: uri.authority,
    });
}

export function normalizePath(path: string): string {
    const path1 = path.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}
