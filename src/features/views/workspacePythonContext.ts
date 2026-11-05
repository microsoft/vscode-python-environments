import { CancellationToken, CancellationTokenSource, Disposable, Uri } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { traceError } from '../../common/logging';
import { createSimpleDebounce } from '../../common/utils/debounce';
import {
    createFileSystemWatcher,
    findFiles,
    getOpenTextDocuments,
    onDidChangeWorkspaceFolders,
    onDidOpenTextDocument,
} from '../../common/workspace.apis';

export const PYTHON_WORKSPACE_KEY = 'python-envs.workspaceHasPython';

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

/** How long deletes and workspace folder changes must settle before the workspace is scanned again. */
export const RESCAN_DEBOUNCE_MS = 500;

async function hasPythonContent(token: CancellationToken): Promise<boolean> {
    const markers = await findFiles(MARKER_GLOB, EXCLUDE, 1, token);
    if (markers.length > 0) {
        return true;
    }
    // `findFiles` only searches workspace folders, so also cover a standalone Python file opened without a folder.
    return getOpenTextDocuments().some((doc) => doc.languageId === 'python');
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

    const setHasPython = async (value: boolean): Promise<void> => {
        if (value === hasPython) {
            return;
        }
        hasPython = value;
        await executeCommand('setContext', PYTHON_WORKSPACE_KEY, value);
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
        try {
            const result = await hasPythonContent(cts.token);
            // A cancelled scan was overtaken by `markHasPython` or by disposal, so its result is stale.
            if (!cts.token.isCancellationRequested) {
                await setHasPython(result);
            }
        } catch (ex) {
            if (!cts.token.isCancellationRequested) {
                traceError('Failed to update the Python workspace context', ex);
            }
        } finally {
            cts.dispose();
            running = undefined;
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
    const markHasPython = (): void => {
        running?.cancel();
        rescanPending = false;
        rescanAfterRunning = false;
        setHasPython(true).catch((ex) => traceError('Failed to update the Python workspace context', ex));
    };

    const onMarkerCreated = (uri: Uri): void => {
        if (!EXCLUDE_RE.test(uri.fsPath)) {
            markHasPython();
        }
    };

    const onMarkerDeleted = (uri: Uri): void => {
        if (EXCLUDE_RE.test(uri.fsPath)) {
            return;
        }
        // A delete can only turn the answer off, so there is nothing to recheck while it is already off,
        // unless a running scan may still report the deleted file.
        if (hasPython === false && !running) {
            return;
        }
        scheduleRescan();
    };

    const watcher = createFileSystemWatcher(MARKER_GLOB, false, true, false);
    disposables.push(
        watcher,
        watcher.onDidCreate(onMarkerCreated),
        watcher.onDidDelete(onMarkerDeleted),
        onDidChangeWorkspaceFolders(() => scheduleRescan()),
        onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'python') {
                markHasPython();
            }
        }),
        new Disposable(() => {
            disposed = true;
            debouncedRescan.dispose();
            running?.cancel();
        }),
    );
    void scan();
}
