import { CancellationToken, CancellationTokenSource, Disposable, FileType, Uri } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { traceError, traceVerbose } from '../../common/logging';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { normalizePath } from '../../common/utils/pathUtils';
import { stat } from '../../common/workspace.fs.apis';
import {
    createFileSystemWatcher,
    findFiles,
    getOpenTextDocuments,
    onDidChangeWorkspaceFolders,
    onDidOpenTextDocument,
} from '../../common/workspace.apis';

export const PYTHON_WORKSPACE_KEY = 'python-envs.workspaceHasPython';

/** How long deletes and workspace folder changes must settle before the workspace is scanned again. */
export const RESCAN_DEBOUNCE_MS = 500;
/** A slow workspace search must not block context updates indefinitely. */
export const SCAN_TIMEOUT_MS = 5000;

/**
 * Files that identify a workspace as a Python one.
 *
 * `findFiles` only returns files, never directories, so virtual environments are detected through
 * their `pyvenv.cfg` rather than a `.venv`/`.conda` folder. `*.py` already covers `setup.py`,
 * `manage.py`, `app.py`, etc.
 *
 * Keep the `workspaceContains:` entries in `activationEvents` (package.json) in sync with this list,
 * otherwise the extension is not activated and the context key is never set.
 */
export const MARKER_GLOB =
    '**/{*.py,*.pyi,*.ipynb,pyproject.toml,requirements.txt,Pipfile,pyvenv.cfg,mspythonconfig.json}';
const EXCLUDE = '**/{node_modules,.git,site-packages}/**';
// `createFileSystemWatcher` has no exclude option, so the same folders are filtered in the handlers.
const EXCLUDE_RE = /[\\/](node_modules|\.git|site-packages)[\\/]/;

function getMarkerKey(uri: Uri): string {
    return JSON.stringify([uri.scheme, uri.authority, normalizePath(uri.fsPath), uri.query, uri.fragment]);
}

async function findPythonContent(token: CancellationToken): Promise<{ hasPython: boolean; marker?: Uri }> {
    const markers = await findFiles(MARKER_GLOB, EXCLUDE, 1, token);
    // `findFiles` only searches workspace folders, so also cover a standalone Python file opened without a folder.
    return {
        hasPython: markers.length > 0 || getOpenTextDocuments().some((doc) => doc.languageId === 'python'),
        marker: markers[0],
    };
}

/**
 * Keeps the `python-envs.workspaceHasPython` context key up to date. It controls whether the Python
 * activity bar icon and its views are shown.
 *
 * Every `findFiles` call is a full workspace search, and a branch switch can create or delete
 * thousands of marker files at once, so events never scan directly:
 * - a new marker file or an opened Python document proves the answer is `true` without a scan;
 * - deletes and workspace folder changes can turn it `false`, so they share one debounced rescan;
 * - only one scan runs at a time, and a rescan requested meanwhile runs once after it.
 */
export function registerWorkspacePythonContext(disposables: Disposable[]): void {
    let hasPython: boolean | undefined;
    let running: CancellationTokenSource | undefined;
    let rescanAfterRunning = false;
    // `SimpleDebounce` cannot be cancelled, so a pending rescan is dropped by clearing this flag.
    let rescanPending = false;
    let disposed = false;
    let knownMarker: string | undefined;
    let nextCreateId = 0;
    const pendingCreates = new Map<string, number>();
    let deletedWhileScanning = new Set<string>();

    const setHasPython = async (value: boolean): Promise<void> => {
        if (value === hasPython) {
            return;
        }
        hasPython = value;
        try {
            await executeCommand('setContext', PYTHON_WORKSPACE_KEY, value);
        } catch (ex) {
            if (hasPython === value) {
                hasPython = undefined;
            }
            throw ex;
        }
    };

    const scan = async (): Promise<void> => {
        if (disposed) {
            return;
        }
        if (running) {
            rescanAfterRunning = true;
            return;
        }
        const cts = new CancellationTokenSource();
        running = cts;
        let timedOut = false;
        deletedWhileScanning = new Set();
        const timeout = setTimeout(() => {
            timedOut = true;
            traceVerbose(`Workspace Python marker search exceeded ${SCAN_TIMEOUT_MS} ms; keeping the current context`);
            cts.cancel();
        }, SCAN_TIMEOUT_MS);
        const cancelTimeout = cts.token.onCancellationRequested(() => clearTimeout(timeout));
        try {
            const result = await findPythonContent(cts.token);
            clearTimeout(timeout);
            // A cancelled scan was overtaken by `markHasPython` or by disposal, so its result is stale.
            if (!cts.token.isCancellationRequested) {
                const foundMarker = result.marker ? getMarkerKey(result.marker) : undefined;
                if (foundMarker && deletedWhileScanning.has(foundMarker)) {
                    rescanAfterRunning = true;
                } else {
                    knownMarker = foundMarker;
                    await setHasPython(result.hasPython);
                }
            }
        } catch (ex) {
            if (!cts.token.isCancellationRequested && !timedOut) {
                traceError('Failed to update the Python workspace context', ex);
            }
        } finally {
            clearTimeout(timeout);
            cancelTimeout.dispose();
            cts.dispose();
            running = undefined;
            deletedWhileScanning = new Set();
        }
        if (rescanAfterRunning && !disposed) {
            rescanAfterRunning = false;
            await scan();
        }
    };

    const debouncedRescan = createSimpleDebounce(RESCAN_DEBOUNCE_MS, () => {
        if (rescanPending) {
            rescanPending = false;
            void scan();
        }
    });

    const scheduleRescan = (): void => {
        if (!disposed) {
            rescanPending = true;
            debouncedRescan.trigger();
        }
    };

    // A new marker file or an opened Python document proves the answer is `true`, whatever a running or
    // pending scan would report.
    const markHasPython = (uri?: Uri): void => {
        if (disposed) {
            return;
        }
        running?.cancel();
        rescanPending = false;
        rescanAfterRunning = false;
        deletedWhileScanning.clear();
        if (uri && !knownMarker) {
            knownMarker = getMarkerKey(uri);
        }
        setHasPython(true).catch((ex) => traceError('Failed to update the Python workspace context', ex));
    };

    const onMarkerCreated = (uri: Uri): void => {
        if (disposed || EXCLUDE_RE.test(uri.fsPath)) {
            return;
        }
        const key = getMarkerKey(uri);
        const createId = ++nextCreateId;
        pendingCreates.set(key, createId);
        void stat(uri).then(
            (fileStat) => {
                if (pendingCreates.get(key) !== createId) {
                    return;
                }
                pendingCreates.delete(key);
                if ((fileStat.type & FileType.File) === FileType.File) {
                    markHasPython(uri);
                }
            },
            (ex) => {
                if (pendingCreates.get(key) === createId) {
                    pendingCreates.delete(key);
                    traceError('Failed to inspect a created Python marker', ex);
                }
            },
        );
    };

    const onMarkerDeleted = (uri: Uri): void => {
        if (EXCLUDE_RE.test(uri.fsPath)) {
            return;
        }
        const key = getMarkerKey(uri);
        pendingCreates.delete(key);
        const deletedKnownMarker = key === knownMarker;
        if (deletedKnownMarker) {
            knownMarker = undefined;
        }
        if (running) {
            deletedWhileScanning.add(key);
            if (deletedKnownMarker) {
                rescanAfterRunning = true;
            }
            return;
        }
        if (!deletedKnownMarker) {
            return;
        }
        scheduleRescan();
    };

    const watcher = createFileSystemWatcher(MARKER_GLOB, false, true, false);
    disposables.push(
        watcher,
        watcher.onDidCreate(onMarkerCreated),
        watcher.onDidDelete(onMarkerDeleted),
        onDidChangeWorkspaceFolders(() => {
            pendingCreates.clear();
            // The marker and running search may belong to a removed folder.
            knownMarker = undefined;
            rescanAfterRunning = false;
            running?.cancel();
            scheduleRescan();
        }),
        onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'python') {
                markHasPython();
            }
        }),
        new Disposable(() => {
            disposed = true;
            pendingCreates.clear();
            debouncedRescan.dispose();
            running?.cancel();
        }),
    );
    if (getOpenTextDocuments().some((doc) => doc.languageId === 'python')) {
        markHasPython();
    }
    void scan();
}
