// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { EnvironmentManagerCapability, PackageManagerCapability, Support } from './capabilities.js';
import {
    EnvironmentCapability,
    PackageCapability,
    supportedCapability,
    unsupportedCapability,
} from './capabilities.js';
import type { EnvironmentManager, PackageManager } from './types.js';

/**
 * @deprecated Use the capabilities advertisement instead of relying on legacy method presence.
 * Infers legacy package support from method presence without invoking operations or reading advertisements.
 * @param packageManager Provider whose methods are inspected.
 * @param capability Package capability to infer.
 * @returns Structural support, not a guarantee of tool-version or option support.
 */
export async function getLegacyPackageManagerCapability(
    packageManager: PackageManager,
    capability: PackageManagerCapability,
): Promise<Support> {
    switch (capability) {
        case PackageCapability.List:
            return getMethodSupport(packageManager.getPackages, packageManager.refresh);
        case PackageCapability.Install:
        case PackageCapability.Uninstall:
        case PackageCapability.Upgrade:
            return getMethodSupport(packageManager.manage);
        case PackageCapability.ListDirect:
            return getMethodSupport(packageManager.getDirectPackageNames);
        case PackageCapability.ListAvailableVersions:
            return getMethodSupport(packageManager.getPackageAvailableVersions);
        default:
            return getMethodSupport();
    }
}

/**
 * @deprecated Use the capabilities advertisement instead of relying on legacy method presence.
 * Infers legacy environment support from method presence without invoking operations or reading advertisements.
 * @param environmentManager Provider whose methods are inspected.
 * @param capability Environment capability to infer.
 * @returns Structural support; the methods are not executed to verify their behavior.
 */
export async function getLegacyEnvironmentManagerCapability(
    environmentManager: EnvironmentManager,
    capability: EnvironmentManagerCapability,
): Promise<Support> {
    switch (capability) {
        case EnvironmentCapability.List:
            return getMethodSupport(environmentManager.getEnvironments, environmentManager.refresh);
        case EnvironmentCapability.Resolve:
            return getMethodSupport(environmentManager.resolve);
        case EnvironmentCapability.GetSelected:
            return getMethodSupport(environmentManager.get);
        case EnvironmentCapability.SetSelected:
            return getMethodSupport(environmentManager.set);
        case EnvironmentCapability.Create:
            return getMethodSupport(environmentManager.create);
        case EnvironmentCapability.Remove:
            return getMethodSupport(environmentManager.remove);
        default:
            return getMethodSupport();
    }
}

async function getMethodSupport(...methods: unknown[]): Promise<Support> {
    const support = await (methods.length > 0 && methods.every((method) => typeof method === 'function')
        ? supportedCapability({})
        : unsupportedCapability({}));
    return { ...support, isLegacy: true };
}
