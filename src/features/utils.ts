import { window } from 'vscode';
import { InstallPermissionEnum, SimpleResponseEnum } from './packageManagement';

export type SettingsPackageTrust = {
    [key: string]: InstallPermissionEnum.AlwaysAllow | InstallPermissionEnum.AlwaysAsk;
};

export const ALWAYS_ALLOW = 'Always Allow installs';
export const ALWAYS_ASK = 'Always Ask before installs';
export const INSTALL_NO_CONFIGURE = 'Install without configuring';

export const YES_INSTALL = 'Yes, Install';
export const NO_INSTALL = 'Do Not Install';

export function promptForInstallPermissions(extensionName: string, packages: string): Thenable<InstallPermissionEnum> {
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
                        resolve(InstallPermissionEnum.AlwaysAllow);
                        break;
                    case ALWAYS_ASK:
                        resolve(InstallPermissionEnum.AlwaysAsk);
                        break;
                    case INSTALL_NO_CONFIGURE:
                        resolve(InstallPermissionEnum.InstallNoConfigure);
                        break;
                    default:
                        resolve(InstallPermissionEnum.Cancel);
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
                        resolve(SimpleResponseEnum.YesInstall);
                        break;
                    case NO_INSTALL:
                        resolve(SimpleResponseEnum.NoInstall);
                        break;
                    default:
                        resolve(SimpleResponseEnum.Cancel);
                        break;
                }
            });
    });
}
