import { Common, Pickers } from '../localize';
import { showQuickPick } from '../window.apis';

export async function pickPackageOptions(): Promise<string | undefined> {
    const items = [
        {
            label: Common.install,
            description: Pickers.Packages.installPackages,
        },
        {
            label: Common.uninstall,
            description: Pickers.Packages.uninstallPackages,
        },
    ];
    const selected = await showQuickPick(items, {
        placeHolder: Pickers.Packages.selectOption,
        ignoreFocusOut: true,
        matchOnDescription: false,
        matchOnDetail: false,
    });
    return selected?.label;
}
