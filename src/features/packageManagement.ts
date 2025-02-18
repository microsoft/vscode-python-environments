import { window } from 'vscode';
import { traceInfo } from '../common/logging';
import { getCallingExtension } from '../common/utils/frameUtils';
import { getConfiguration } from '../common/workspace.apis';
import { SettingsPackageTrust, promptForInstallPermissions, promptForAlwaysAsk } from './utils';

export enum InstallPermissionEnum {
    AlwaysAllow = 'alwaysAllow',
    AlwaysAsk = 'alwaysAsk',
    InstallNoConfigure = 'installNoConfigure',
    Cancel = 'cancel',
}

export enum SimpleResponseEnum {
    YesInstall = 'yesInstall',
    NoInstall = 'noInstall',
    Cancel = 'cancel',
}
export async function packageManagementFlow(packages: string[]): Promise<void> {
    // what does it mean to return, will we tell the calling extension about it?
    //check to see if pkg was already installed?
    const callingExtension = getCallingExtension();
    traceInfo(`Python API: Installing packages for extension: '${callingExtension}'`);
    const config = getConfiguration('python-envs');
    let extPkgTrustConfig: SettingsPackageTrust | undefined =
        config.get<SettingsPackageTrust>('allowAutoPackageManagement');
    let callingExtensionTrustLevel;
    let isConfigured = true;
    if (extPkgTrustConfig === undefined) {
        // TODO:s THIS DOESN'T WORK
        // no package trust config, default to alwaysAsk
        callingExtensionTrustLevel = InstallPermissionEnum.AlwaysAsk;
        isConfigured = false;
    } else {
        // check for package trust settings
        callingExtensionTrustLevel = extPkgTrustConfig[callingExtension];
        if (callingExtensionTrustLevel === undefined) {
            // no specific package trust settings, checking wildcard in config
            callingExtensionTrustLevel = extPkgTrustConfig['*'];
            if (callingExtensionTrustLevel === undefined) {
                // no wildcard in config, default to alwaysAsk
                callingExtensionTrustLevel = InstallPermissionEnum.AlwaysAsk;
                isConfigured = false;
            }
        }
    }
    traceInfo(`package trust settings for '${callingExtension}' is ${callingExtensionTrustLevel}`);

    if (!isConfigured) {
        // calling extension has no config, user has no wildcard setup
        // prompt user to "alwaysAsk" or "alwaysAllow"
        const selectedOption = await promptForInstallPermissions(callingExtension, packages.join(', '));
        if (selectedOption === InstallPermissionEnum.Cancel) {
            // user cancelled the prompt, exit
            window.showErrorMessage(`Package installation of ${packages.join(', ')} was canceled by the user.`);
            return Promise.reject('User cancelled the package installation.');
        }
        if (selectedOption !== InstallPermissionEnum.InstallNoConfigure) {
            // meaning the user selected "alwaysAsk" or "alwaysAllow", update the config
            const newExtTrustConfig = { ...extPkgTrustConfig, [callingExtension]: selectedOption };
            config.update('allowAutoPackageManagement', newExtTrustConfig, true);
        }
    } else {
        // user has already configured package trust settings for this extension
        if (callingExtensionTrustLevel === InstallPermissionEnum.AlwaysAsk) {
            traceInfo('Package installation is pending user confirmation due to trust settings.');
            // prompt user to allow or deny package installation
            const simpleResponse = await promptForAlwaysAsk(callingExtension, packages.join(', '));
            if (simpleResponse === SimpleResponseEnum.NoInstall || simpleResponse === SimpleResponseEnum.Cancel) {
                // user cancelled the prompt, exit
                window.showErrorMessage(`Package installation of ${packages.join(', ')} was canceled by the user.`);
                return Promise.reject('User cancelled the package installation.');
            }
        }
        // if callingExtensionTrustLevel is 'alwaysAllow' just continue to install
    }
    // actually install the packages
    return Promise.resolve();
}
