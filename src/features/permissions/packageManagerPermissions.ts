import { l10n, SecretStorage } from 'vscode';
import { pickExtension } from './pickers';
import { showInformationMessage, showWarningMessage } from '../../common/window.apis';
import { PermissionsCommon } from '../../common/localize';
import { traceLog } from '../../common/logging';
import { allExtensions } from '../../common/extension.apis';
import { getCallingExtension } from '../../common/utils/frameUtils';

type PermissionType = 'Ask' | 'Allow' | 'Deny';
function validatePermissionType(value: string): value is PermissionType {
    return ['Ask', 'Allow', 'Deny'].includes(value);
}

export interface PermissionsManager<T> {
    getPermissions(extensionId: string): Promise<T | undefined>;
    setPermissions(extensionId: string, permissions: T | undefined): Promise<void>;
    resetPermissions(): Promise<void>;
}

export interface PackageManagerPermissions extends PermissionsManager<PermissionType> {}
export class PackageManagerPermissionsImpl implements PackageManagerPermissions {
    constructor(private readonly secretStore: SecretStorage) {}

    async getPermissions(extensionId: string): Promise<PermissionType | undefined> {
        const permission: string | undefined = await this.secretStore.get(
            `python-envs.permissions.packageManagement.${extensionId}`,
        );
        if (permission) {
            if (validatePermissionType(permission)) {
                return permission as PermissionType;
            }
        }
        // else if (extensionId === PYTHON_EXTENSION_ID || extensionId === ENVS_EXTENSION_ID) {
        //     // Default to allow for the Python extension and the Envs extension
        //     return 'Allow';
        // }
        return undefined;
    }

    async setPermissions(extensionId: string, permissions: PermissionType): Promise<void> {
        await this.secretStore.store(`python-envs.permissions.packageManagement.${extensionId}`, permissions);
    }

    async resetPermissions(): Promise<void> {
        const ids = allExtensions().map((e) => `python-envs.permissions.packageManagement.${e.id}`);
        await Promise.all(ids.map((id) => this.secretStore.delete(id)));
        traceLog('All package management permissions have been reset.');
    }
}

function getPackageListAsString(packages: string[]): string {
    const maxStrLength = 100;
    let result = '';
    let count = 0;

    for (const pkg of packages) {
        if (result.length + pkg.length + (result ? 2 : 0) > maxStrLength) {
            break;
        }
        result += (result ? ', ' : '') + pkg;
        count++;
    }

    const remaining = packages.length - count;
    if (remaining > 0) {
        result += l10n.t('... and {0} others', remaining);
    }

    return result;
}

async function configureFirstTimePermissions(extensionId: string, pm: PackageManagerPermissions) {
    const response = await showInformationMessage(
        l10n.t(
            'The extension {0} wants to install, upgrade, or uninstall packages from your Python environments',
            extensionId,
        ),
        { modal: true },
        {
            title: PermissionsCommon.ask,
            isCloseAffordance: true,
        },
        { title: PermissionsCommon.allow },
        { title: PermissionsCommon.deny },
    );
    if (response?.title === PermissionsCommon.ask) {
        await pm.setPermissions(extensionId, 'Ask');
        traceLog('Package management permissions set to "ask" for extension: ', extensionId);
        return true;
    } else if (response?.title === PermissionsCommon.allow) {
        await pm.setPermissions(extensionId, 'Allow');
        traceLog('Package management permissions set to "allow" for extension: ', extensionId);
        return true;
    } else if (response?.title === PermissionsCommon.deny) {
        await pm.setPermissions(extensionId, 'Deny');
        traceLog('Package management permissions set to "deny" for extension: ', extensionId);
        return false;
    } else {
        traceLog('Package management permissions not changed for extension: ', extensionId);
        return false;
    }
}

export async function checkPackageManagementPermissions(
    pm: PackageManagerPermissions,
    mode: 'install' | 'uninstall' | 'changes',
    packages?: string[],
): Promise<boolean> {
    const extensionId = getCallingExtension();

    const currentPermission = await pm.getPermissions(extensionId);
    if (currentPermission === 'Allow') {
        return true;
    } else if (currentPermission === 'Deny') {
        traceLog(`Package management permissions denied for extension: ${extensionId}`);
        setImmediate(async () => {
            const response = await showWarningMessage(
                l10n.t(
                    'The extension `{0}` is not allowed to {1} packages into your Python environment.',
                    extensionId,
                    mode,
                ),
                PermissionsCommon.setPermissions,
            );
            if (response === PermissionsCommon.setPermissions) {
                handlePermissionsCommand(pm, extensionId);
            }
        });
        return false;
    } else if (currentPermission === undefined) {
        return await configureFirstTimePermissions(extensionId, pm);
    }

    // Below handles Permission level is 'Ask'
    let message = l10n.t('The extension `{0}` wants to install packages into your Python environment.', extensionId);
    if (mode === 'uninstall') {
        message = l10n.t('The extension `{0}` wants to uninstall packages from your Python environment.', extensionId);
    } else if (mode === 'changes') {
        message = l10n.t('The extension `{0}` wants to make changes to your Python environment.', extensionId);
    }

    const response = await showInformationMessage(
        message,
        {
            modal: true,
            detail: packages ? l10n.t('Packages: {0}', getPackageListAsString(packages)) : undefined,
        },
        { title: PermissionsCommon.allow },
        { title: PermissionsCommon.deny, isCloseAffordance: true },
    );
    if (response?.title === PermissionsCommon.allow) {
        traceLog(`Package management permissions granted for extension: ${extensionId}`);
        return true;
    }
    traceLog(`Package management permissions denied for extension: ${extensionId}`);
    return false;
}

export async function handlePermissionsCommand(pm: PermissionsManager<PermissionType>, extensionId?: string) {
    extensionId = extensionId ?? (await pickExtension());
    if (!extensionId) {
        return;
    }

    const currentPermission = await pm.getPermissions(extensionId);

    const response = await showInformationMessage(
        l10n.t(
            'Set permissions for the extension {0} to install, upgrade, or uninstall packages from your Python environments',
            extensionId,
        ),
        {
            modal: true,
            detail: currentPermission ? l10n.t('Current permission: {0}', currentPermission) : undefined,
        },
        PermissionsCommon.ask,
        PermissionsCommon.allow,
        PermissionsCommon.deny,
    );

    if (response === PermissionsCommon.ask) {
        await pm.setPermissions(extensionId, 'Ask');
        traceLog('Package management permissions set to "ask" for extension: ', extensionId);
    } else if (response === PermissionsCommon.allow) {
        await pm.setPermissions(extensionId, 'Allow');
        traceLog('Package management permissions set to "allow" for extension: ', extensionId);
    } else if (response === PermissionsCommon.deny) {
        await pm.setPermissions(extensionId, 'Deny');
        traceLog('Package management permissions set to "deny" for extension: ', extensionId);
    } else {
        traceLog('Package management permissions not changed for extension: ', extensionId);
    }
}
