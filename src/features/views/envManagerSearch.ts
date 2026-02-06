import { commands } from 'vscode';

/**
 * Opens environment search settings at workspace level.
 */
export async function openSearchSettings(): Promise<void> {
    await commands.executeCommand(
        'workbench.action.openWorkspaceSettings',
        '@ext:ms-python.vscode-python-envs "search path"',
    );
}
