// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';
import { Capabilities, CapabilityCheck, EnvironmentManagerCapability, PackageManagerCapability, supportedCapability, EnvironmentCapability, PackageCapability } from '../../capabilities';

/**
 * Every environment manager implements `list` (list/refresh), `resolve`, `getSelected`, and
 * `setSelected`; spread into a manager's `capabilities` to advertise unconditional support without
 * repeating the same `supportedCapability` checks. Override a key afterward for a manager where
 * that operation isn't meaningful (e.g. resolving an interpreter/environment URI).
 */
export const requiredEnvironmentCapabilities: Pick<
    Capabilities<EnvironmentManagerCapability>,
    typeof EnvironmentCapability.List | typeof EnvironmentCapability.Resolve | typeof EnvironmentCapability.GetSelected | typeof EnvironmentCapability.SetSelected
> = {
    [EnvironmentCapability.List]: supportedCapability,
    [EnvironmentCapability.Resolve]: supportedCapability,
    [EnvironmentCapability.GetSelected]: supportedCapability,
    [EnvironmentCapability.SetSelected]: supportedCapability,
};

/**
 * Every package manager implements listing and refresh; spread into a manager's `capabilities`
 * to advertise them through `packages.list`.
 */
export const requiredPackageCapabilities: Pick<
    Capabilities<PackageManagerCapability>,
    typeof PackageCapability.List
> = {
    [PackageCapability.List]: supportedCapability,
};

/**
 * Discovery-only environment managers (e.g. pyenv, poetry, pipenv) list and select environments
 * but never create or remove them. Spread into a manager's `capabilities` with its display name.
 */
export function discoveryOnlyEnvironmentCapabilities(managerName: string): Capabilities<EnvironmentManagerCapability> {
    const create: CapabilityCheck = async () => ({
        supported: false,
        reason: l10n.t('{0} does not support creating environments.', managerName),
    });
    return {
        ...requiredEnvironmentCapabilities,
        [EnvironmentCapability.Create]: create,
        [EnvironmentCapability.Remove]: async () => ({
            supported: false,
            reason: l10n.t('{0} does not support removing environments.', managerName),
        }),
    };
}
