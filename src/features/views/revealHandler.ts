import { activeTextEditor } from '../../common/window.apis';
import { WorkspaceView } from './projectView';
import { EnvManagerView } from './envManagersView';
import { PythonStatusBar } from './pythonStatusBar';
import { isPythonProjectFile } from '../../common/utils/fileNameUtils';
import { PythonEnvironmentApi } from '../../api';

export function updateViewsAndStatus(
    statusBar: PythonStatusBar,
    workspaceView: WorkspaceView,
    managerView: EnvManagerView,
    api: PythonEnvironmentApi,
) {
    const activeDocument = activeTextEditor()?.document;
    if (!activeDocument || activeDocument.isUntitled || activeDocument.uri.scheme !== 'file') {
        statusBar.hide();
        return;
    }

    if (
        activeDocument.languageId !== 'python' &&
        activeDocument.languageId !== 'pip-requirements' &&
        !isPythonProjectFile(activeDocument.uri.fsPath)
    ) {
        statusBar.hide();
        return;
    }

    const env = workspaceView.reveal(activeDocument.uri);
    managerView.reveal(env);
    if (env) {
        statusBar.show(env?.displayName);
    } else {
        setImmediate(async () => {
            const e = await api.getEnvironment(activeDocument.uri);
            statusBar.show(e?.displayName);
        });
    }
}
