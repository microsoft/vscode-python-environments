import * as fsapi from 'fs-extra';
import { CancellationToken, GlobPattern, RelativePattern, Uri, WorkspaceFolder } from 'vscode';
import { traceLog, traceWarn } from './logging';
import { getUserHomeDir, isSameOrParentPath } from './utils/pathUtils';
import { findFiles, getWorkspaceFolders } from './workspace.apis';

export interface WorkspaceSearchOptions {
    /** Names the feature in log messages. */
    readonly label: string;
    readonly include: string;
    readonly exclude: string;
    /** The most matches to return; the search stops once it has this many. */
    readonly maxResults: number;
    /**
     * The folders whose files the caller uses. A workspace folder that is the user's home folder,
     * or contains it, is searched only inside these folders. Without them it is not searched.
     */
    readonly neededFolders?: readonly Uri[];
    /** Passed to `findFiles` unchanged. */
    readonly token?: CancellationToken;
}

/**
 * Returns whether a search of `folder` walks the user's home folder, because it is that folder or
 * one of its parents. Paths are compared after normalization (separators, and case on Windows).
 */
function containsHomeFolder(folder: Uri): boolean {
    const home = getUserHomeDir();
    return !!home && folder.scheme === 'file' && isSameOrParentPath(folder.fsPath, home);
}

/**
 * Runs `findFiles` with a result cap. A workspace folder that is the user's home folder, or
 * contains it, is never searched whole: a search there walks the whole profile (AppData, caches,
 * virtual environments) and can run for minutes. Only the caller's needed folders inside it are
 * searched. The other workspace folders are searched whole.
 *
 * There is no time limit: VS Code resolves a cancelled `findFiles` to an empty list, not to the
 * matches found so far, so a limit would drop every match. A caller that can wait long passes a
 * token the user can cancel.
 */
export async function findFilesInWorkspace(options: WorkspaceSearchOptions): Promise<Uri[]> {
    const folders = getWorkspaceFolders() ?? [];
    if (!folders.some((folder) => containsHomeFolder(folder.uri))) {
        return search(options, [options.include]);
    }
    const bases = await Promise.all(folders.map((folder) => foldersToSearch(folder, options)));
    const includes = outermostFolders(bases.flat()).map((base) => new RelativePattern(base, options.include));
    return includes.length > 0 ? search(options, includes) : [];
}

/**
 * Returns the folders to search in place of one workspace folder: the folder itself, or, when it
 * is the home folder or contains it, the needed folders inside it that do not contain home.
 */
async function foldersToSearch(folder: WorkspaceFolder, options: WorkspaceSearchOptions): Promise<Uri[]> {
    if (!containsHomeFolder(folder.uri)) {
        return [folder.uri];
    }
    const candidates = (options.neededFolders ?? []).filter(
        (uri) => isSameOrParentPath(folder.uri.fsPath, uri.fsPath) && !containsHomeFolder(uri),
    );
    const isFolder = await Promise.all(candidates.map(isDirectory));
    const inside = candidates.filter((_uri, index) => isFolder[index]);
    traceLog(
        `${options.label}: not searching all of workspace folder ${folder.uri.fsPath} for ${options.include}, ` +
            "because it is the user's home folder or contains it, and a search there walks the whole profile." +
            (inside.length > 0 ? ` Searching only ${inside.map((uri) => uri.fsPath).join(', ')}.` : ''),
    );
    return inside;
}

/**
 * Returns whether `uri` is a folder. ripgrep cannot start in a file or a missing folder, and a
 * failed start fails the whole `findFiles` call. Projects can be single files.
 */
async function isDirectory(uri: Uri): Promise<boolean> {
    try {
        return (await fsapi.stat(uri.fsPath)).isDirectory();
    } catch {
        return false;
    }
}

/** Drops each folder that sits inside another folder of the list, and each repeat. */
function outermostFolders(folders: readonly Uri[]): Uri[] {
    return folders.filter((folder, index) =>
        folders.every(
            (other, otherIndex) =>
                otherIndex === index ||
                !isSameOrParentPath(other.fsPath, folder.fsPath) ||
                (index < otherIndex && isSameOrParentPath(folder.fsPath, other.fsPath)),
        ),
    );
}

async function search(options: WorkspaceSearchOptions, includes: GlobPattern[]): Promise<Uri[]> {
    const resultSets = await Promise.all(
        includes.map((include) => findFiles(include, options.exclude, options.maxResults, options.token)),
    );
    // `?? []` keeps the callers' existing handling of a search that resolves to undefined.
    const results = resultSets.flatMap((resultSet) => resultSet ?? []).slice(0, options.maxResults);
    if (results.length >= options.maxResults) {
        traceWarn(
            `${options.label}: the search for ${options.include} stopped at ${options.maxResults} ` +
                'results; matching files past that are left out.',
        );
    }
    return results;
}
