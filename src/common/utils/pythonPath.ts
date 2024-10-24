import { Uri, Progress, CancellationToken } from 'vscode';
import { PythonEnvironment } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';
import { showErrorMessage } from '../errors/utils';
import { traceInfo, traceVerbose, traceError } from '../logging';
import { PYTHON_EXTENSION_ID } from '../constants';

const priorityOrder = [
    `${PYTHON_EXTENSION_ID}:pyenv`,
    `${PYTHON_EXTENSION_ID}:pixi`,
    `${PYTHON_EXTENSION_ID}:conda`,
    `${PYTHON_EXTENSION_ID}:pipenv`,
    `${PYTHON_EXTENSION_ID}:poetry`,
    `${PYTHON_EXTENSION_ID}:activestate`,
    `${PYTHON_EXTENSION_ID}:hatch`,
    `${PYTHON_EXTENSION_ID}:venv`,
    `${PYTHON_EXTENSION_ID}:system`,
];
function sortManagersByPriority(managers: InternalEnvironmentManager[]): InternalEnvironmentManager[] {
    return managers.sort((a, b) => {
        const aIndex = priorityOrder.indexOf(a.id);
        const bIndex = priorityOrder.indexOf(b.id);
        if (aIndex === -1 && bIndex === -1) {
            return 0;
        }
        if (aIndex === -1) {
            return 1;
        }
        if (bIndex === -1) {
            return -1;
        }
        return aIndex - bIndex;
    });
}

export async function handlePythonPath(
    interpreterUri: Uri,
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    reporter?: Progress<{ message?: string; increment?: number }>,
    token?: CancellationToken,
): Promise<PythonEnvironment | undefined> {
    for (const manager of sortManagersByPriority(projectEnvManagers)) {
        if (token?.isCancellationRequested) {
            return;
        }
        reporter?.report({ message: `Checking ${manager.displayName}` });
        traceInfo(`Checking ${manager.displayName} (${manager.id}) for ${interpreterUri.fsPath}`);
        const env = await manager.resolve(interpreterUri);
        if (env) {
            traceInfo(`Using ${manager.displayName} (${manager.id}) to handle ${interpreterUri.fsPath}`);
            return env;
        }
        traceVerbose(`Manager ${manager.displayName} (${manager.id}) cannot handle ${interpreterUri.fsPath}`);
    }

    const checkedIds = projectEnvManagers.map((m) => m.id);
    const filtered = managers.filter((m) => !checkedIds.includes(m.id));

    for (const manager of sortManagersByPriority(filtered)) {
        if (token?.isCancellationRequested) {
            return;
        }
        reporter?.report({ message: `Checking ${manager.displayName}` });
        traceInfo(`Checking ${manager.displayName} (${manager.id}) for ${interpreterUri.fsPath}`);
        const env = await manager.resolve(interpreterUri);
        if (env) {
            traceInfo(`Using ${manager.displayName} (${manager.id}) to handle ${interpreterUri.fsPath}`);
            return env;
        }
    }

    if (token?.isCancellationRequested) {
        return;
    }

    traceError(`Unable to handle ${interpreterUri.fsPath}`);
    showErrorMessage(`Unable to handle ${interpreterUri.fsPath}`);
    return undefined;
}
