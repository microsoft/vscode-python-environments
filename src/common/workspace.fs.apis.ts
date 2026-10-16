import { FileStat, Uri, workspace } from 'vscode';
import { isFileNotFoundError } from './utils/filesystem';

export function readFile(uri: Uri): Thenable<Uint8Array> {
    return workspace.fs.readFile(uri);
}

export function stat(uri: Uri): Thenable<FileStat> {
    return workspace.fs.stat(uri);
}

/**
 * Checks whether a workspace file system entry exists.
 *
 * @param uri The URI of the entry to check.
 * @returns Whether the entry exists.
 */
export async function pathExists(uri: Uri): Promise<boolean> {
    try {
        await workspace.fs.stat(uri);
        return true;
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return false;
        }
        throw error;
    }
}
