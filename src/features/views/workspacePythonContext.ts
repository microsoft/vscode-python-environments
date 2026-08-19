import { Disposable } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { createFileSystemWatcher, findFiles, onDidChangeWorkspaceFolders } from '../../common/workspace.apis';

export const PYTHON_WORKSPACE_KEY = 'python-envs.workspaceHasPython';

const MARKER_GLOB = '**/{*.py,pyproject.toml,setup.py,requirements.txt,Pipfile,manage.py,app.py,.venv,.conda,mspythonconfig.json}';
const EXCLUDE = '**/{node_modules,.git,site-packages}/**';

async function refresh(): Promise<void> {
    const hits = await findFiles(MARKER_GLOB, EXCLUDE, 1);
    await executeCommand('setContext', PYTHON_WORKSPACE_KEY, hits.length > 0);
}

export function registerWorkspacePythonContext(disposables: Disposable[]): void {
    const watcher = createFileSystemWatcher(MARKER_GLOB, false, true, false);
    disposables.push(
        watcher,
        watcher.onDidCreate(() => void refresh()),
        watcher.onDidDelete(() => void refresh()),
        onDidChangeWorkspaceFolders(() => void refresh()),
    );
    void refresh();
}