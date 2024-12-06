import { activeTextEditor } from '../../common/window.apis';
import { ProjectView } from './projectView';
import { EnvManagerView } from './envManagersView';
import { PythonStatusBar } from './pythonStatusBar';
import { isPythonProjectFile } from '../../common/utils/fileNameUtils';
import { PythonEnvironmentApi } from '../../api';

export function updateViewsAndStatus(
    statusBar: PythonStatusBar,
    workspaceView: ProjectView,
    managerView: EnvManagerView,
    api: PythonEnvironmentApi,
) {
    workspaceView.updateProject();

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

    workspaceView.reveal(activeDocument.uri);
    setImmediate(async () => {
        const env = await api.getEnvironment(activeDocument.uri);
        statusBar.show(env?.displayName);
        managerView.reveal(env);
    });
}
