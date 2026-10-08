// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { Capabilities, EnvironmentManagerCapability, PackageManagerCapability } from '../../capabilities';

/**
 * Every environment manager implements these operations; spread into a manager's `capabilities`
 * to advertise them without repeating the same `{ supported: true }` checks.
 */
export const requiredEnvironmentCapabilities: Pick<
    Capabilities<EnvironmentManagerCapability>,
    'environments.list' | 'environments.refresh' | 'environments.resolve' | 'environments.getSelected' | 'environments.setSelected'
> = {
    'environments.list': async () => ({ supported: true }),
    'environments.refresh': async () => ({ supported: true }),
    'environments.resolve': async () => ({ supported: true }),
    'environments.getSelected': async () => ({ supported: true }),
    'environments.setSelected': async () => ({ supported: true }),
};

/**
 * Every package manager implements these operations; spread into a manager's `capabilities`
 * to advertise them without repeating the same `{ supported: true }` checks.
 */
export const requiredPackageCapabilities: Pick<
    Capabilities<PackageManagerCapability>,
    'packages.list' | 'packages.refresh' | 'packages.manage'
> = {
    'packages.list': async () => ({ supported: true }),
    'packages.refresh': async () => ({ supported: true }),
    'packages.manage': async () => ({ supported: true }),
};
