import { Disposable, Uri } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { traceError } from '../../common/logging';
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

async function hasPythonContent(): Promise<boolean> {
    const markers = await findFiles(MARKER_GLOB, EXCLUDE, 1);
    if (markers.length > 0) {
        return true;
    }
    // `findFiles` only searches workspace folders, so also cover a standalone Python file opened without a folder.
    return getOpenTextDocuments().some((doc) => doc.languageId === 'python');
}

/**
 * Keeps the `python-envs.workspaceHasPython` context key up to date. It controls whether the Python
 * activity bar icon and its views are shown.
 */
export function registerWorkspacePythonContext(disposables: Disposable[]): void {
    // Every refresh takes a ticket and only the newest one may write the context key, so a slow older
    // scan can never overwrite the result of a newer one.
    let latestTicket = 0;

    const refresh = async (): Promise<void> => {
        const ticket = ++latestTicket;
        try {
            const hasPython = await hasPythonContent();
            if (ticket === latestTicket) {
                await executeCommand('setContext', PYTHON_WORKSPACE_KEY, hasPython);
            }
        } catch (ex) {
            traceError('Failed to update the Python workspace context', ex);
        }
    };

    const onMarkerChanged = (uri: Uri): void => {
        if (!EXCLUDE_RE.test(uri.fsPath)) {
            void refresh();
        }
    };

    const watcher = createFileSystemWatcher(MARKER_GLOB, false, true, false);
    disposables.push(
        watcher,
        watcher.onDidCreate(onMarkerChanged),
        watcher.onDidDelete(onMarkerChanged),
        onDidChangeWorkspaceFolders(() => void refresh()),
        onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'python') {
                void refresh();
            }
        }),
    );
    void refresh();
}