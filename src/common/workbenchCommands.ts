import { commands, Uri } from 'vscode';

export async function installExtension(
    extensionId: Uri | string,
    options?: {
        installOnlyNewlyAddedFromExtensionPackVSIX?: boolean;
        installPreReleaseVersion?: boolean;
        donotSync?: boolean;
    },
): Promise<void> {
    await commands.executeCommand('workbench.extensions.installExtension', extensionId, options);
}

export async function openExtension(extensionId: string): Promise<void> {
    await commands.executeCommand('extension.open', extensionId);
}
