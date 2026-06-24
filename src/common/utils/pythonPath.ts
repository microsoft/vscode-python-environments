import { CancellationToken, Progress, Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';
import { PYTHON_EXTENSION_ID } from '../constants';
import { traceVerbose, traceWarn } from '../logging';

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
    const systemId = priorityOrder[priorityOrder.length - 1];
    return managers.sort((a, b) => {
        const aIndex = priorityOrder.indexOf(a.id);
        const bIndex = priorityOrder.indexOf(b.id);
        if (aIndex === -1 && bIndex === -1) {
            return 0;
        }
        if (aIndex === -1) {
            // Unknown managers should come before system (last resort) but after other known managers
            return b.id === systemId ? -1 : 1;
        }
        if (bIndex === -1) {
            return a.id === systemId ? 1 : -1;
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
    // Use the managers user has set for the project first. Likely, these
    // managers are the ones that should be used.
    for (const manager of sortManagersByPriority(projectEnvManagers)) {
        if (token?.isCancellationRequested) {
            return;
        }
        reporter?.report({ message: `Checking ${manager.displayName}` });
        traceVerbose(`Checking ${manager.displayName} (${manager.id}) for ${interpreterUri.fsPath}`);
        const env = await manager.resolve(interpreterUri);
        if (env) {
            traceVerbose(`Using ${manager.displayName} (${manager.id}) to handle ${interpreterUri.fsPath}`);
            return env;
        }
        traceVerbose(`Manager ${manager.displayName} (${manager.id}) cannot handle ${interpreterUri.fsPath}`);
    }

    // If the project managers cannot handle the interpreter, then try all the managers
    // that user has installed. Excluding anything that is already checked.
    const checkedIds = projectEnvManagers.map((m) => m.id);
    const filtered = managers.filter((m) => !checkedIds.includes(m.id));

    for (const manager of sortManagersByPriority(filtered)) {
        if (token?.isCancellationRequested) {
            return;
        }
        reporter?.report({ message: `Checking ${manager.displayName}` });
        traceVerbose(`Checking ${manager.displayName} (${manager.id}) for ${interpreterUri.fsPath}`);
        const env = await manager.resolve(interpreterUri);
        if (env) {
            traceVerbose(`Using ${manager.displayName} (${manager.id}) to handle ${interpreterUri.fsPath}`);
            return env;
        }
    }

    traceWarn(`Unable to handle ${interpreterUri.fsPath}`);
    return undefined;
}
