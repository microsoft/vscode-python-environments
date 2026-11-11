import { CancellationToken, CancellationTokenSource, Disposable, FileType, Uri } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { traceError, traceVerbose } from '../../common/logging';
import { createSimpleDebounce } from '../../common/utils/debounce';
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
/** A slow rescan must not block context updates after the initial value is known. */
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

async function findPythonContent(token: CancellationToken): Promise<boolean> {
    const markers = await findFiles(MARKER_GLOB, EXCLUDE, 1, token);
    // `findFiles` only searches workspace folders, so also cover a standalone Python file opened without a folder.
    return markers.length > 0 || getOpenTextDocuments().some((doc) => doc.languageId === 'python');
}

/**
 * Keeps the `python-envs.workspaceHasPython` context key up to date. It controls whether the Python
 * activity bar icon and its views are shown.
 *
 * Every `findFiles` call is a full workspace search, and a branch switch can create or delete
 * thousands of marker files at once, so events never scan directly:
 * - a created marker that is a file, or an opened Python document, proves the answer is `true`;
 * - deletes and workspace folder changes can turn it `false`, so they share one debounced rescan;
 * - only one scan runs at a time, and a scan that may have missed a change is rerun once afterwards.
 */
export function registerWorkspacePythonContext(disposables: Disposable[]): void {
    let hasPython: boolean | undefined;
    let running: CancellationTokenSource | undefined;
    // Set when something changed during the running scan, so its result may be stale.
    let rescanAfterRunning = false;
    // `SimpleDebounce` cannot be cancelled, so a pending rescan is dropped by clearing this flag.
    let rescanPending = false;
    let disposed = false;
    let nextCheckId = 0;
    // Created markers whose `stat` is in flight, so a later delete or folder change can invalidate them.
    const pendingChecks = new Map<string, number>();

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
        // Only the initial search must finish; later ones keep the current value if they are too slow.
        const timeout =
            hasPython === undefined
                ? undefined
                : setTimeout(() => {
                      if (!cts.token.isCancellationRequested) {
                          traceVerbose(
                              `Workspace Python marker search exceeded ${SCAN_TIMEOUT_MS} ms; keeping the current context`,
                          );
                          cts.cancel();
                      }
                  }, SCAN_TIMEOUT_MS);
        try {
            const result = await findPythonContent(cts.token);
            if (!cts.token.isCancellationRequested && !rescanAfterRunning) {
                await setHasPython(result);
            }
        } catch (ex) {
            if (!cts.token.isCancellationRequested) {
                traceError('Failed to update the Python workspace context', ex);
            }
        } finally {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
            cts.dispose();
            running = undefined;
        }
        if (rescanAfterRunning) {
            rescanAfterRunning = false;
            scheduleRescan();
        }
    };

    // Overrides any running or pending scan, which could only report a stale answer.
    const markHasPython = (): void => {
        if (disposed) {
            return;
        }
        running?.cancel();
        rescanPending = false;
        rescanAfterRunning = false;
        setHasPython(true).catch((ex) => traceError('Failed to update the Python workspace context', ex));
    };

    const onMarkerCreated = (uri: Uri): void => {
        if (disposed || EXCLUDE_RE.test(uri.fsPath)) {
            return;
        }
        // While the answer is settled as `true`, a new marker cannot change it.
        if (hasPython === true && !running && !rescanPending) {
            return;
        }
        const key = uri.toString();
        if (pendingChecks.has(key)) {
            return;
        }
        const checkId = ++nextCheckId;
        pendingChecks.set(key, checkId);
        // The watcher also reports directories that match the glob, such as a `tools.py` folder.
        stat(uri).then(
            (fileStat) => {
                if (pendingChecks.get(key) !== checkId) {
                    return;
                }
                pendingChecks.delete(key);
                if ((fileStat.type & FileType.File) === FileType.File) {
                    markHasPython();
                }
            },
            (ex) => {
                if (pendingChecks.get(key) === checkId) {
                    pendingChecks.delete(key);
                    traceError('Failed to inspect a created Python marker', ex);
                }
            },
        );
    };

    const onMarkerDeleted = (uri: Uri): void => {
        if (disposed || EXCLUDE_RE.test(uri.fsPath)) {
            return;
        }
        pendingChecks.delete(uri.toString());
        if (running) {
            // The running scan may already have listed the deleted file.
            rescanAfterRunning = true;
        } else if (hasPython !== false) {
            scheduleRescan();
        }
    };

    const watcher = createFileSystemWatcher(MARKER_GLOB, false, true, false);
    disposables.push(
        watcher,
        watcher.onDidCreate(onMarkerCreated),
        watcher.onDidDelete(onMarkerDeleted),
        onDidChangeWorkspaceFolders(() => {
            // Pending checks and the running scan may belong to a removed folder.
            pendingChecks.clear();
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
            pendingChecks.clear();
            debouncedRescan.dispose();
            running?.cancel();
        }),
    );
    if (getOpenTextDocuments().some((doc) => doc.languageId === 'python')) {
        markHasPython();
    }
    void scan();
}
