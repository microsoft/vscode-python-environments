// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Shared, fully-supported capability maps for unit test fixtures. Every manager must advertise
 * every capability key; tests that aren't exercising capability behavior itself can spread these
 * constants into their fake managers instead of repeating the full key list.
 */

import type { Capabilities, EnvironmentManagerCapability, PackageManagerCapability } from '../capabilities';

const supported = async () => ({ supported: true }) as const;

export const allSupportedEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    'environments.list': supported,
    'environments.refresh': supported,
    'environments.resolve': supported,
    'environments.getSelected': supported,
    'environments.setSelected': supported,
    'environments.create': supported,
    'environments.create.quick': supported,
    'environments.create.additionalPackages': supported,
    'environments.remove': supported,
    'environments.remove.headless': supported,
};

export const allSupportedPackageCapabilities: Capabilities<PackageManagerCapability> = {
    'packages.list': supported,
    'packages.list.skipCache': supported,
    'packages.refresh': supported,
    'packages.manage': supported,
    'packages.manage.install': supported,
    'packages.manage.uninstall': supported,
    'packages.manage.upgrade': supported,
    'packages.manage.headless': supported,
    'packages.manage.showSkipOption': supported,
    'packages.direct': supported,
    'packages.availableVersions': supported,
};
