import { window } from 'vscode';
import { InstallPermission, SimpleResponse } from './packageManagement';

export type SettingsPackageTrust = {
    [key: string]: InstallPermission.AlwaysAllow | InstallPermission.AlwaysAsk;
};

export const ALWAYS_ALLOW = 'Always Allow installs';
export const ALWAYS_ASK = 'Always Ask before installs';
export const INSTALL_NO_CONFIGURE = 'Install without configuring';

export const YES_INSTALL = 'Yes, Install';
export const NO_INSTALL = 'Do Not Install';

export function promptForInstallPermissions(extensionName: string, packages: string): Thenable<InstallPermission> {
    return new Promise((resolve) => {
        window
            .showInformationMessage(
                'Select future permissions for package installs from the ' + extensionName + ' extension.',
                {
                    detail: `package/s: "${packages}"`,
                    modal: true,
                },
                ALWAYS_ASK,
                ALWAYS_ALLOW,
                INSTALL_NO_CONFIGURE,
            )
            .then((selectedOption) => {
                switch (selectedOption) {
                    case ALWAYS_ALLOW:
                        resolve(InstallPermission.AlwaysAllow);
                        break;
                    case ALWAYS_ASK:
                        resolve(InstallPermission.AlwaysAsk);
                        break;
                    case INSTALL_NO_CONFIGURE:
                        resolve(InstallPermission.InstallNoConfigure);
                        break;
                    default:
                        resolve(InstallPermission.Cancel);
                        break;
                }
            });
    });
}

export function promptForAlwaysAsk(extensionName: string, packages: string): Thenable<string | undefined> {
    return new Promise((resolve) => {
        window
            .showInformationMessage(
                'Do you want to install the following package/s from the ' + extensionName + ' extension?',
                {
                    detail: `package/s: "${packages}"`,
                    modal: true,
                },
                YES_INSTALL,
                NO_INSTALL,
            )
            .then((selectedOption) => {
                switch (selectedOption) {
                    case YES_INSTALL:
                        resolve(SimpleResponse.YesInstall);
                        break;
                    case NO_INSTALL:
                        resolve(SimpleResponse.NoInstall);
                        break;
                    default:
                        resolve(SimpleResponse.Cancel);
                        break;
                }
            });
    });
}
