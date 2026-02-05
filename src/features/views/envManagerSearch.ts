import * as path from 'path';
import { commands, ConfigurationTarget, window } from 'vscode';
import { Common, EnvManagerSearchStrings } from '../../common/localize';
import { traceLog } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { normalizePathKeepGlobs } from '../../common/utils/pathUtils';
import { getConfiguration, getWorkspaceFolders } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';

const SUPPRESS_SAVE_PROMPT_KEY = 'python-envs.search.fullWorkspace.suppressSavePrompt';

/**
 * Handles the Environment Managers view search action.
 * Performs a full workspace search for Python environments.
 */
export async function handleEnvManagerSearchAction(
    envManagers: EnvironmentManagers,
    nativeFinder: NativePythonFinder,
): Promise<void> {
    await runFullWorkspaceSearch(envManagers, nativeFinder);
}

/**
 * Opens environment search settings.
 */
export async function openSearchSettings(): Promise<void> {
    await commands.executeCommand('workbench.action.openSettings', '@ext:ms-python.vscode-python-envs "search path"');
}

/**
 * Performs a recursive search for Python environments across all workspace folders.
 * Uses the `./**` glob pattern to search the entire workspace tree.
 * After the search completes, prompts the user to save the search pattern to settings.
 */
export async function runFullWorkspaceSearch(
    envManagers: EnvironmentManagers,
    nativeFinder: NativePythonFinder,
): Promise<void> {
    const workspaceFolders = getWorkspaceFolders();
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    // Construct search paths for all workspace folders
    const searchPaths = workspaceFolders.map((folder) => path.join(folder.uri.fsPath, '**'));
    traceLog('Full workspace search:', searchPaths);

    nativeFinder.setTemporarySearchPaths(searchPaths);
    try {
        await Promise.all(envManagers.managers.map((manager) => manager.refresh(undefined)));
    } finally {
        nativeFinder.setTemporarySearchPaths(undefined);
    }

    await promptToSaveSearchPaths(['./**']);
}

/**
 * Prompts the user to save the search paths to workspace settings.
 * Respects the user's "Don't show again" preference stored in persistent state.
 */
async function promptToSaveSearchPaths(searchPaths: string[]): Promise<void> {
    const state = await getWorkspacePersistentState();
    const suppressPrompt = await state.get<boolean>(SUPPRESS_SAVE_PROMPT_KEY, false);
    if (suppressPrompt) {
        return;
    }

    const response = await window.showInformationMessage(
        EnvManagerSearchStrings.saveSearchPrompt,
        Common.yes,
        Common.no,
        EnvManagerSearchStrings.dontShowAgain,
    );

    if (response === EnvManagerSearchStrings.dontShowAgain) {
        await state.set(SUPPRESS_SAVE_PROMPT_KEY, true);
        return;
    }

    if (response === Common.yes) {
        await appendWorkspaceSearchPaths(searchPaths);
    }
}

/**
 * Appends new search paths to the workspace-level `workspaceSearchPaths` setting.
 * Deduplicates paths using case-insensitive comparison on Windows.
 */
export async function appendWorkspaceSearchPaths(searchPaths: string[]): Promise<void> {
    const config = getConfiguration('python-envs');
    const inspection = config.inspect<string[]>('workspaceSearchPaths');
    const currentPaths = inspection?.workspaceValue ?? [];
    const normalizedCurrent = new Set(currentPaths.map((value) => normalizePathKeepGlobs(value)));
    const filteredSearchPaths = searchPaths.filter((value) => {
        const normalized = normalizePathKeepGlobs(value);
        return normalized && !normalizedCurrent.has(normalized);
    });

    if (filteredSearchPaths.length === 0) {
        return;
    }

    const nextPaths = [...currentPaths, ...filteredSearchPaths];
    await config.update('workspaceSearchPaths', nextPaths, ConfigurationTarget.Workspace);
}
