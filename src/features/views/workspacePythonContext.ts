import { CancellationTokenSource, Disposable, FileType, Uri } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { traceError } from '../../common/logging';
import { createSimpleDebounce } from '../../common/utils/debounce';
import { isFileNotFoundError } from '../../common/utils/filesystem';
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

// `findFiles` only searches workspace folders, so also cover a standalone Python file opened without a folder.
function hasOpenPythonDocument(): boolean {
    return getOpenTextDocuments().some((doc) => doc.languageId === 'python');
}

/** Whether deleting `deleted` also removes `uri`, because it is the same file or one of its parent folders. */
function isRemovedBy(uri: string, deleted: string): boolean {
    return uri === deleted || uri.startsWith(`${deleted}/`);
}

/**
 * Keeps the `python-envs.workspaceHasPython` context key up to date. It controls whether the Python
 * activity bar icon and its views are shown.
 *
 * Every `findFiles` call is a full workspace search, and a branch switch can create or delete
 * thousands of marker files at once, so events never scan directly:
 * - a created marker that is a file, or an opened Python document, proves the answer is `true`;
 * - one marker known to exist is remembered, so deleting any other marker only re-checks that it still exists;
 * - deleting that marker, or a folder containing it, and workspace folder changes share one debounced rescan;
 * - only one scan runs at a time, and it is rerun if the marker it found was deleted during the search.
 *
 * Scans are not timed out: creates and opened Python documents override a slow scan, and workspace
 * folder changes cancel it.
 *
 * The watcher does not report markers removed with a folder whose name does not match the glob, so
 * the context can stay `true` until a later marker delete re-checks the remembered marker.
 */
export function registerWorkspacePythonContext(disposables: Disposable[]): void {
    let hasPython: boolean | undefined;
    // The value VS Code last accepted, and whether an update is in flight.
    let published: boolean | undefined;
    let publishing = false;
    // A marker file known to exist. While it does, the answer stays `true`.
    let witness: string | undefined;
    let running: CancellationTokenSource | undefined;
    // Markers deleted during the running scan, which may have returned one of them.
    const deletedDuringScan = new Set<string>();
    // Set when a rescan was requested while a scan was running.
    let rescanAfterRunning = false;
    // `SimpleDebounce` has no `cancel()`, so a pending rescan is dropped by clearing this flag.
    let rescanPending = false;
    let disposed = false;
    let nextCheckId = 0;
    // Created markers whose `stat` is in flight, so a later delete or folder change can invalidate them.
    const pendingChecks = new Map<string, number>();

    // Sends one update at a time, always with the latest value, so a slow update cannot overwrite a newer one.
    const publish = async (): Promise<void> => {
        publishing = true;
        while (!disposed && hasPython !== undefined && hasPython !== published) {
            const value = hasPython;
            try {
                await executeCommand('setContext', PYTHON_WORKSPACE_KEY, value);
                published = value;
            } catch (ex) {
                traceError('Failed to update the Python workspace context', ex);
                // Let the next update retry.
                if (hasPython === value) {
                    hasPython = undefined;
                }
            }
        }
        publishing = false;
    };

    const setHasPython = (value: boolean): void => {
        if (value === hasPython) {
            return;
        }
        hasPython = value;
        if (!publishing) {
            void publish();
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

    // The watcher misses some deletes, such as markers removed with their folder, so the witness is re-checked.
    const verifyWitness = async (): Promise<void> => {
        const candidate = witness;
        if (disposed || candidate === undefined) {
            return;
        }
        let exists = false;
        try {
            exists = ((await stat(Uri.parse(candidate))).type & FileType.File) === FileType.File;
        } catch (ex) {
            if (!isFileNotFoundError(ex)) {
                traceError('Failed to inspect the found Python marker', ex);
            }
            // Treated as missing; the rescan finds the marker if it still exists.
        }
        if (!exists && !disposed && witness === candidate) {
            witness = undefined;
            scheduleRescan();
        }
    };

    const debouncedVerifyWitness = createSimpleDebounce(RESCAN_DEBOUNCE_MS, () => void verifyWitness());

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
        // The scan finds a new witness; until then, deletes are checked against its result instead.
        witness = undefined;
        let result: boolean | undefined;
        try {
            const [found] = await findFiles(MARKER_GLOB, EXCLUDE, 1, cts.token);
            if (!cts.token.isCancellationRequested) {
                const key = found?.toString();
                if (key !== undefined && [...deletedDuringScan].some((deleted) => isRemovedBy(key, deleted))) {
                    rescanAfterRunning = true;
                } else {
                    witness = key;
                    result = key !== undefined || hasOpenPythonDocument();
                }
            }
        } catch (ex) {
            if (!cts.token.isCancellationRequested) {
                traceError('Failed to search the workspace for Python files', ex);
            }
        } finally {
            cts.dispose();
            running = undefined;
            deletedDuringScan.clear();
        }
        if (result !== undefined) {
            setHasPython(result);
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
        setHasPython(true);
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
                    // Keep an existing witness, which is less likely to be a short-lived file.
                    witness ??= key;
                    markHasPython();
                }
            },
            (ex) => {
                if (pendingChecks.get(key) !== checkId) {
                    return;
                }
                pendingChecks.delete(key);
                // A short-lived file, such as a temporary one, cannot change the answer.
                if (isFileNotFoundError(ex)) {
                    return;
                }
                traceError('Failed to inspect a created Python marker', ex);
                // A search still finds the marker if it is a file.
                scheduleRescan();
            },
        );
    };

    const onMarkerDeleted = (uri: Uri): void => {
        if (disposed || EXCLUDE_RE.test(uri.fsPath)) {
            return;
        }
        const key = uri.toString();
        pendingChecks.delete(key);
        // While the witness exists, deleting another marker cannot change the answer, so only check that it does.
        if (witness !== undefined && !isRemovedBy(witness, key)) {
            debouncedVerifyWitness.trigger();
            return;
        }
        witness = undefined;
        if (running && !running.token.isCancellationRequested) {
            // The running scan checks its result against this.
            deletedDuringScan.add(key);
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
            // The witness, pending checks and running scan may belong to a removed folder.
            witness = undefined;
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
            debouncedVerifyWitness.dispose();
            running?.cancel();
        }),
    );
    if (hasOpenPythonDocument()) {
        markHasPython();
    }
    void scan();
}
