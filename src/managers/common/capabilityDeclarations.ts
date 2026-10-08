// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';
import { Capabilities, CapabilityCheck, EnvironmentManagerCapability, PackageManagerCapability, supportedCapability } from '../../capabilities';

/**
 * Every environment manager implements these operations; spread into a manager's `capabilities`
 * to advertise them without repeating the same `supportedCapability` checks.
 */
export const requiredEnvironmentCapabilities: Pick<
    Capabilities<EnvironmentManagerCapability>,
    'environments.list' | 'environments.refresh' | 'environments.resolve' | 'environments.getSelected' | 'environments.setSelected'
> = {
    'environments.list': supportedCapability,
    'environments.refresh': supportedCapability,
    'environments.resolve': supportedCapability,
    'environments.getSelected': supportedCapability,
    'environments.setSelected': supportedCapability,
};

/**
 * Every package manager implements these operations; spread into a manager's `capabilities`
 * to advertise them without repeating the same `supportedCapability` checks.
 */
export const requiredPackageCapabilities: Pick<
    Capabilities<PackageManagerCapability>,
    'packages.list' | 'packages.refresh' | 'packages.manage'
> = {
    'packages.list': supportedCapability,
    'packages.refresh': supportedCapability,
    'packages.manage': supportedCapability,
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
        'environments.create': create,
        'environments.create.quick': create,
        'environments.remove': async () => ({
            supported: false,
            reason: l10n.t('{0} does not support removing environments.', managerName),
        }),
    };
}
