import { l10n } from 'vscode';

export namespace Common {
    export const recommended = l10n.t('recommended');
    export const install = l10n.t('Install');
    export const uninstall = l10n.t('Uninstall');
    export const openInBrowser = l10n.t('Open in Browser');
    export const openInEditor = l10n.t('Open in Editor');
}

export namespace Interpreter {
    export const statusBarSelect = l10n.t('Select Interpreter');
}

export namespace PackageManagement {
    export const selectPackagesToInstall = l10n.t('Select packages to install');
    export const enterPackageNames = l10n.t('Enter package names');
    export const commonPackages = l10n.t('Search common packages');
    export const commonPackagesDescription = l10n.t('Search and Install common packages');
    export const workspaceDependencies = l10n.t('Install workspace dependencies');
    export const workspaceDependenciesDescription = l10n.t('Install dependencies found in the current workspace.');
    export const selectPackagesToUninstall = l10n.t('Select packages to uninstall');
    export const enterPackagesPlaceHolder = l10n.t('Enter package names separated by space');
    export const editArguments = l10n.t('Edit arguments');
}
