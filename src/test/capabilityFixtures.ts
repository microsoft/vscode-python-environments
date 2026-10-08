// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Shared, fully-supported capability maps for unit test fixtures. Every manager must advertise
 * every capability key; tests that aren't exercising capability behavior itself can spread these
 * constants into their fake managers instead of repeating the full key list.
 */

import { Capabilities, EnvironmentManagerCapability, PackageManagerCapability, supportedCapability } from '../capabilities';

export const allSupportedEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    'environments.list': supportedCapability,
    'environments.refresh': supportedCapability,
    'environments.resolve': supportedCapability,
    'environments.getSelected': supportedCapability,
    'environments.setSelected': supportedCapability,
    'environments.create': supportedCapability,
    'environments.create.quick': supportedCapability,
    'environments.remove': supportedCapability,
};

export const allSupportedPackageCapabilities: Capabilities<PackageManagerCapability> = {
    'packages.list': supportedCapability,
    'packages.refresh': supportedCapability,
    'packages.manage': supportedCapability,
    'packages.manage.install': supportedCapability,
    'packages.manage.uninstall': supportedCapability,
    'packages.manage.upgrade': supportedCapability,
    'packages.direct': supportedCapability,
    'packages.availableVersions': supportedCapability,
};
