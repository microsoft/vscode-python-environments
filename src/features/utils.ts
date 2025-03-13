import { window } from 'vscode';
import { InstallPermissionEnum, SimpleResponseEnum } from './packageManagement';

export type SettingsPackageTrust = {
    [key: string]: InstallPermissionEnum.AlwaysAllow | InstallPermissionEnum.AlwaysAsk;
};

export const ALWAYS_ALLOW = 'Always allow';
export const ALWAYS_ASK = 'Ask every time';
export const INSTALL_NO_CONFIGURE = 'Install without configuring permissions';

export const YES_INSTALL = 'Yes, Install';
export const NO_INSTALL = 'Do Not Install';

export function promptForInstallPermissions(
    extensionName: string,
    packages: string[],
): Thenable<InstallPermissionEnum> {
    const extName = extensionName.split('.')[1];
    if (packages.length < 1) {
        return Promise.reject('No packages to install.');
    }
    let detailStr = `'${extensionName}' wants to install the package '${packages[0]}'.`;
    if (packages.length > 1) {
        detailStr = `'${extensionName}' wants to install packages '${packages.join(', ')}'.`;
    }
    detailStr = `Set permissions for this and future package installations from '${extensionName}'.`;
    return new Promise((resolve) => {
        window
            .showInformationMessage(
                `Allow extension '${extName}' to install packages?`,
                {
                    detail: detailStr,
                    modal: true,
                },
                ALWAYS_ASK,
                ALWAYS_ALLOW,
            )
            .then((selectedOption) => {
                switch (selectedOption) {
                    case ALWAYS_ALLOW:
                        window.showInformationMessage(
                            `${extName} extension installed ${packages.join(', ')} package and is always allowed to install in the future.`,
                            'Configure'
                        ).then((selection) => {
                            if (selection === 'Configure') {
                                // Add logic to open the configuration settings
                            }
                        });
                        resolve(InstallPermissionEnum.AlwaysAllow);
                        break;
                    case ALWAYS_ASK:
                        resolve(InstallPermissionEnum.AlwaysAsk);
                        break;
                    default:
                        resolve(InstallPermissionEnum.Cancel);
                        break;
                }
            });
    });
}

export function promptForAlwaysAsk(extensionName: string, packages: string[]): Thenable<string | undefined> {
    const extName = extensionName.split('.')[1];
    if (packages.length < 1) {
        return Promise.reject('No packages to install.');
    }
    let detailStr = `${extName} wants to install '${packages[0]}' package.`;
    if (packages.length > 1) {
        detailStr = `${extName} wants to install '${packages.join(', ')}' packages.`;
    }
    return new Promise((resolve) => {
        window
            .showInformationMessage(
                `Allow ${extName} to Install Packages?`,
                {
                    detail: detailStr,
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
