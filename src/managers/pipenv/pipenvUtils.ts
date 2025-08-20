// Utility functions for Pipenv environment management

import { traceInfo } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { NativePythonFinder } from '../common/nativePythonFinder';
import which from 'which';

export const PIPENV_PATH_KEY = `${ENVS_EXTENSION_ID}:pipenv:PIPENV_PATH`;
export const PIPENV_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:pipenv:WORKSPACE_SELECTED`;
export const PIPENV_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:pipenv:GLOBAL_SELECTED`;

let pipenvPath: string | undefined;

async function findPipenv(): Promise<string | undefined> {
    try {
        return await which('pipenv');
    } catch {
        return undefined;
    }
}

export async function clearPipenvCache(): Promise<void> {
    pipenvPath = undefined;
}

export async function getPipenv(native?: NativePythonFinder): Promise<string | undefined> {
    if (pipenvPath) {
        return pipenvPath;
    }

    const state = await getWorkspacePersistentState();
    pipenvPath = await state.get<string>(PIPENV_PATH_KEY);
    if (pipenvPath) {
        traceInfo(`Using pipenv from persistent state: ${pipenvPath}`);
        return pipenvPath;
    }

    // Try to find pipenv in PATH
    const foundPipenv = await findPipenv();
    if (foundPipenv) {
        pipenvPath = foundPipenv;
        traceInfo(`Found pipenv in PATH: ${foundPipenv}`);
        return foundPipenv;
    }

    // TODO: Add fallback to native finder when available
    if (native) {
        // Future enhancement: use native finder to locate pipenv
        traceInfo('Native finder available but not yet implemented for pipenv detection');
    }

    traceInfo('Pipenv not found');
    return undefined;
}

export class PipenvUtils {
    // Add static helper methods for pipenv operations here
}
