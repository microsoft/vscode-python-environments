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
    /** Passed to `findFiles` unchanged. */
    readonly token?: CancellationToken;
}

/**
 * Returns whether a search of `folder` walks the user's home folder, because it is that folder or
 * one of its parents. Paths are compared after normalization (separators, and case on Windows).
 */
function containsHomeFolder(folder: WorkspaceFolder): boolean {
    const home = getUserHomeDir();
    return !!home && folder.uri.scheme === 'file' && isSameOrParentPath(folder.uri.fsPath, home);
}

/**
 * Runs `findFiles` with a result cap. A workspace folder that is the user's home folder, or
 * contains it, is not searched: a search there walks the whole profile (AppData, caches, virtual
 * environments) and can run for minutes. The other folders are still searched.
 *
 * There is no time limit: VS Code resolves a cancelled `findFiles` to an empty list, not to the
 * matches found so far, so a limit would drop every match. A caller that can wait long passes a
 * token the user can cancel.
 */
export async function findFilesInWorkspace(options: WorkspaceSearchOptions): Promise<Uri[]> {
    const folders = getWorkspaceFolders() ?? [];
    const homeFolders = folders.filter(containsHomeFolder);
    if (homeFolders.length === 0) {
        return search(options, [options.include]);
    }
    for (const folder of homeFolders) {
        traceLog(
            `${options.label}: not searching workspace folder ${folder.uri.fsPath} for ${options.include}, ` +
                "because it is the user's home folder or contains it, and a search there walks the whole profile.",
        );
    }
    const includes = folders
        .filter((folder) => !homeFolders.includes(folder))
        .map((folder) => new RelativePattern(folder, options.include));
    return includes.length > 0 ? search(options, includes) : [];
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
