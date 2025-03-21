import { Extension, QuickPickItem } from 'vscode';
import { allExternalExtensions } from '../../common/extension.apis';
import { showQuickPick } from '../../common/window.apis';

function getExtensionName(ext: Extension<unknown>): string {
    try {
        return ext.packageJSON.name;
    } catch {
        return '';
    }
}

function getExtensionItems(): QuickPickItem[] {
    const extensions = allExternalExtensions();
    return extensions.map((ext) => {
        return {
            description: ext.id,
            label: getExtensionName(ext),
        };
    });
}

export async function pickExtensionForPermissions(): Promise<string | undefined> {
    const items = getExtensionItems();

    const result = await showQuickPick(items, {
        ignoreFocusOut: true,
    });

    return result?.description;
}
