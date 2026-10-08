// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Capabilities, EnvironmentManagerCapability, PackageManagerCapability, supportedCapability } from '../../capabilities';

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
